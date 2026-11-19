import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fal } from '@fal-ai/client';
import { StorageService } from '../storage/storage.service';

let configured = false;

@Injectable()
export class FalAiProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.FAL_KEY);
  }

  private ensureConfigured() {
    if (configured) return;
    fal.config({ credentials: process.env.FAL_KEY });
    configured = true;
  }

  private imageSize(ratio: string): string {
    if (ratio === '9:16') return 'portrait_16_9';
    if (ratio === '16:9') return 'landscape_16_9';
    return 'square_hd';
  }

  async generateImage(prompt: string, ratio = '1:1'): Promise<string> {
    if (!this.isAvailable()) throw new Error('FAL_KEY is not configured.');
    this.ensureConfigured();
    const result = await fal.subscribe(process.env.FAL_FLUX_MODEL || 'fal-ai/flux/dev', {
      input: { prompt, image_size: this.imageSize(ratio) },
    });
    const url = (result.data as any)?.images?.[0]?.url;
    if (!url) throw new Error('fal.ai FLUX returned no image.');
    return this.storage.download(url, 'png');
  }

  async animateImage(imagePath: string, prompt: string, durationSec = 5): Promise<string> {
    if (!this.isAvailable()) throw new Error('FAL_KEY is not configured.');
    this.ensureConfigured();
    const data = await fs.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const file = new File([new Uint8Array(data)], `input${ext || '.png'}`, { type: mime });
    const imageUrl = await fal.storage.upload(file);

    const duration = durationSec >= 8 ? '10' : '5';
    const result = await fal.subscribe(process.env.FAL_KLING_MODEL || 'fal-ai/kling-video/v2.6/pro/image-to-video', {
      input: { prompt, start_image_url: imageUrl, duration },
    });
    const url = (result.data as any)?.video?.url;
    if (!url) throw new Error('fal.ai Kling returned no video.');
    return this.storage.download(url, 'mp4');
  }
}
