import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class ModalVideoProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.MODAL_WAN_VIDEO_URL);
  }

  async animateImage(imagePath: string, prompt: string, durationSec = 5): Promise<string> {
    if (!this.isAvailable()) throw new Error('MODAL_WAN_VIDEO_URL is not configured.');
    const data = await fs.readFile(imagePath);
    const response = await fetch(process.env.MODAL_WAN_VIDEO_URL as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image_base64: data.toString('base64'),
        prompt,
        duration_sec: durationSec,
      }),
    });
    if (!response.ok) throw new Error(`Modal Wan video endpoint failed: ${response.status} ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.storage.saveBuffer('output', buffer, 'mp4');
  }
}
