import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { boolEnv, intEnv } from '../common/env';
import { translateToEnglish } from '../common/translate';

@Injectable()
export class PollinationsImageProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return !boolEnv('DISABLE_POLLINATIONS_FALLBACK', false);
  }

  private dims(ratio: string): [number, number] {
    if (ratio === '9:16') return [768, 1344];
    if (ratio === '16:9') return [1344, 768];
    return [1024, 1024];
  }

  async generate(prompt: string, negativePrompt = '', ratio = '1:1'): Promise<string> {
    const [width, height] = this.dims(ratio);
    const translatedPrompt = await translateToEnglish(prompt);
    const fullPrompt = negativePrompt ? `${translatedPrompt}. Avoid: ${negativePrompt}` : translatedPrompt;
    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      seed: String(Math.floor(Math.random() * 2_147_483_647)),
      nologo: 'true',
      safe: 'true',
    });
    if (process.env.POLLINATIONS_MODEL) params.set('model', process.env.POLLINATIONS_MODEL);
    if (process.env.POLLINATIONS_TOKEN) params.set('token', process.env.POLLINATIONS_TOKEN);

    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?${params.toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(intEnv('POLLINATIONS_TIMEOUT_MS', 120000)) });
    if (!response.ok) throw new Error(`Pollinations image generation failed: ${response.status} ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.storage.saveBuffer('output', buffer, 'jpg');
  }
}
