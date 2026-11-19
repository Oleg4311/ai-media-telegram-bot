import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class ModalImageProvider {
  constructor(private readonly storage: StorageService) {}

  isZImageAvailable() {
    return Boolean(process.env.MODAL_ZIMAGE_URL);
  }

  isQwenImageAvailable() {
    return Boolean(process.env.MODAL_QWEN_IMAGE_URL);
  }

  private dims(ratio: string): [number, number] {
    if (ratio === '9:16') return [768, 1344];
    if (ratio === '16:9') return [1344, 768];
    return [1024, 1024];
  }

  private async call(url: string, prompt: string, negativePrompt: string, ratio: string): Promise<string> {
    const [width, height] = this.dims(ratio);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, negative_prompt: negativePrompt || undefined, width, height }),
    });
    if (!response.ok) throw new Error(`Modal endpoint failed: ${response.status} ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.storage.saveBuffer('output', buffer, 'png');
  }

  generateZImage(prompt: string, negativePrompt = '', ratio = '1:1'): Promise<string> {
    if (!this.isZImageAvailable()) throw new Error('MODAL_ZIMAGE_URL is not configured.');
    return this.call(process.env.MODAL_ZIMAGE_URL as string, prompt, negativePrompt, ratio);
  }

  generateQwenImage(prompt: string, negativePrompt = '', ratio = '1:1'): Promise<string> {
    if (!this.isQwenImageAvailable()) throw new Error('MODAL_QWEN_IMAGE_URL is not configured.');
    return this.call(process.env.MODAL_QWEN_IMAGE_URL as string, prompt, negativePrompt, ratio);
  }
}
