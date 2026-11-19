import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class RunwayVideoProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.RUNWAYML_API_SECRET);
  }

  private headers() {
    return {
      Authorization: `Bearer ${process.env.RUNWAYML_API_SECRET}`,
      'X-Runway-Version': '2024-11-06',
      'Content-Type': 'application/json',
    };
  }

  private runwayRatio(ratio: string, hasImage: boolean) {
    if (ratio === '9:16') return '720:1280';
    if (ratio === '1:1') return hasImage ? '960:960' : '1280:720';
    return process.env.RUNWAY_RATIO || '1280:720';
  }

  private async toDataUri(filePath: string): Promise<string> {
    let sourcePath = filePath;
    let data = await fs.readFile(sourcePath);
    if (data.length > 4_500_000) {
      sourcePath = await this.storage.allocateTmp('jpg');
      await this.convertToJpeg(filePath, sourcePath);
      data = await fs.readFile(sourcePath);
    }
    const ext = path.extname(sourcePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
  }

  private convertToJpeg(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-y', '-i', input, '-vf', 'scale=1600:-2:force_original_aspect_ratio=decrease', '-q:v', '3', output], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg image conversion failed (${code})`)));
    });
  }

  async generateClip(input: { prompt: string; ratio: string; durationSec: number; imagePath?: string }): Promise<string> {
    if (!this.isAvailable()) throw new Error('RUNWAYML_API_SECRET is not configured.');
    const configuredDuration = Number(process.env.RUNWAY_CLIP_SECONDS || 5);
    const duration = configuredDuration >= 10 ? 10 : 5;
    const payload: Record<string, any> = {
      model: process.env.RUNWAY_VIDEO_MODEL || 'gen4.5',
      promptText: input.prompt,
      ratio: this.runwayRatio(input.ratio, Boolean(input.imagePath)),
      duration,
    };
    if (input.imagePath) payload.promptImage = await this.toDataUri(input.imagePath);

    const response = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Runway create failed: ${response.status} ${await response.text()}`);
    const created = await response.json() as { id?: string };
    if (!created.id) throw new Error('Runway returned no task id.');
    return this.waitForTask(created.id);
  }

  private async waitForTask(id: string): Promise<string> {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const response = await fetch(`https://api.dev.runwayml.com/v1/tasks/${id}`, { headers: this.headers() });
      if (!response.ok) throw new Error(`Runway task failed: ${response.status} ${await response.text()}`);
      const task = await response.json() as any;
      const status = String(task.status || '').toUpperCase();
      if (['FAILED', 'CANCELLED', 'CANCELED'].includes(status)) throw new Error(`Runway task ${status}: ${task.failure || task.failureCode || 'unknown error'}`);
      if (['SUCCEEDED', 'COMPLETED'].includes(status)) {
        const url = Array.isArray(task.output) ? task.output[0] : undefined;
        if (!url || typeof url !== 'string') throw new Error('Runway completed without output URL.');
        return this.storage.download(url, 'mp4');
      }
    }
    throw new Error('Runway task timed out after 20 minutes.');
  }
}
