import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class FfmpegService {
  constructor(private readonly storage: StorageService) {}

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (data) => (stderr += data.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-4000)}`));
      });
    });
  }

  private dims(ratio: string): [number, number] {
    if (ratio === '9:16') return [720, 1280];
    if (ratio === '1:1') return [1080, 1080];
    return [1280, 720];
  }

  async animateImage(inputPath: string, durationSec: number, ratio: string, prompt = ''): Promise<string> {
    const output = await this.storage.allocateOutput('mp4');
    const [w, h] = this.dims(ratio);
    const frames = Math.max(1, Math.round(durationSec * 30));
    const lower = prompt.toLowerCase();
    const zoomExpr = /отдал|zoom out|отъезж/i.test(lower)
      ? `if(lte(on,1),1.12,max(1.0,zoom-0.0008))`
      : `min(zoom+0.0008,1.12)`;
    const filter = [
      `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase`,
      `crop=${w * 2}:${h * 2}`,
      `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30`,
      'format=yuv420p',
    ].join(',');
    await this.run(['-y', '-loop', '1', '-i', inputPath, '-vf', filter, '-t', String(durationSec), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', output]);
    return output;
  }

  async concat(clips: string[], ratio: string, durationSec?: number): Promise<string> {
    const listPath = await this.storage.allocateTmp('txt');
    const escape = (p: string) => p.replace(/'/g, "'\\''");
    await fs.writeFile(listPath, clips.map((clip) => `file '${escape(path.resolve(clip))}'`).join('\n'));
    const output = await this.storage.allocateOutput('mp4');
    const [w, h] = this.dims(ratio);
    await this.run([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=30`,
      ...(durationSec ? ['-t', String(durationSec)] : []),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
    ]);
    await fs.rm(listPath, { force: true }).catch(() => undefined);
    return output;
  }

  async compressForTelegram(input: string, maxMb = 49): Promise<string> {
    const stat = await fs.stat(input);
    if (stat.size <= maxMb * 1024 * 1024) return input;
    const output = await this.storage.allocateOutput('mp4');
    await this.run(['-y', '-i', input, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output]);
    return output;
  }
}
