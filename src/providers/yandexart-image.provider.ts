import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { intEnv } from '../common/env';

const API_HOST = 'https://llm.api.cloud.yandex.net';

@Injectable()
export class YandexArtImageProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
  }

  private headers() {
    return {
      Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
      'content-type': 'application/json',
    };
  }

  private ratioParts(ratio: string): [number, number] {
    if (ratio === '9:16') return [9, 16];
    if (ratio === '16:9') return [16, 9];
    return [1, 1];
  }

  async generate(prompt: string, ratio = '1:1'): Promise<string> {
    if (!this.isAvailable()) throw new Error('YANDEX_API_KEY/YANDEX_FOLDER_ID is not configured.');
    const [widthRatio, heightRatio] = this.ratioParts(ratio);
    const body = {
      modelUri: `art://${process.env.YANDEX_FOLDER_ID}/yandex-art/latest`,
      messages: [{ text: prompt, weight: '1' }],
      generationOptions: {
        seed: String(Math.floor(Math.random() * 2_147_483_647)),
        aspectRatio: { widthRatio: String(widthRatio), heightRatio: String(heightRatio) },
      },
    };
    const response = await fetch(`${API_HOST}/foundationModels/v1/imageGenerationAsync`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`YandexART request failed: ${response.status} ${await response.text()}`);
    const created = (await response.json()) as { id?: string };
    if (!created.id) throw new Error('YandexART returned no operation id.');
    return this.poll(created.id);
  }

  private async poll(operationId: string): Promise<string> {
    const timeout = intEnv('YANDEXART_TIMEOUT_MS', 180000);
    const pollMs = intEnv('YANDEXART_POLL_MS', 3000);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const response = await fetch(`${API_HOST}/operations/${operationId}`, { headers: this.headers() });
      if (!response.ok) continue;
      const data = (await response.json()) as { done?: boolean; response?: { image?: string }; error?: { message?: string } };
      if (data.error) throw new Error(`YandexART generation failed: ${data.error.message || 'unknown error'}`);
      if (data.done) {
        if (!data.response?.image) throw new Error('YandexART finished without image output.');
        return this.storage.saveBuffer('output', Buffer.from(data.response.image, 'base64'), 'jpg');
      }
    }
    throw new Error(`YandexART generation timed out after ${timeout}ms.`);
  }
}
