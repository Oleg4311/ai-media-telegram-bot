import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { intEnv } from '../common/env';

const API_HOST = 'https://api-key.fusionbrain.ai';

@Injectable()
export class FusionBrainImageProvider {
  private cachedModelId: number | null = null;

  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.FUSIONBRAIN_API_KEY && process.env.FUSIONBRAIN_SECRET_KEY);
  }

  private headers() {
    return {
      'X-Key': `Key ${process.env.FUSIONBRAIN_API_KEY}`,
      'X-Secret': `Secret ${process.env.FUSIONBRAIN_SECRET_KEY}`,
    };
  }

  private dims(ratio: string): [number, number] {
    if (ratio === '9:16') return [768, 1344];
    if (ratio === '16:9') return [1344, 768];
    return [1024, 1024];
  }

  private async getModelId(): Promise<number> {
    if (this.cachedModelId != null) return this.cachedModelId;
    const response = await fetch(`${API_HOST}/key/api/v1/models`, { headers: this.headers() });
    if (!response.ok) throw new Error(`FusionBrain /models failed: ${response.status} ${await response.text()}`);
    const models = (await response.json()) as Array<{ id: number; type?: string }>;
    const model = models.find((m) => m.type === 'TEXT2IMAGE') || models[0];
    if (!model) throw new Error('FusionBrain returned no available models.');
    this.cachedModelId = model.id;
    return model.id;
  }

  async generate(prompt: string, negativePrompt = '', ratio = '1:1'): Promise<string> {
    if (!this.isAvailable()) throw new Error('FUSIONBRAIN_API_KEY/FUSIONBRAIN_SECRET_KEY is not configured.');
    const modelId = await this.getModelId();
    const [width, height] = this.dims(ratio);
    const params: Record<string, unknown> = {
      type: 'GENERATE',
      numImages: 1,
      width,
      height,
      generateParams: { query: prompt },
    };
    if (negativePrompt) params.negativePromptUnclip = negativePrompt;
    if (process.env.FUSIONBRAIN_STYLE) params.style = process.env.FUSIONBRAIN_STYLE;

    const form = new FormData();
    form.append('model_id', String(modelId));
    form.append('params', new Blob([JSON.stringify(params)], { type: 'application/json' }));

    const response = await fetch(`${API_HOST}/key/api/v1/text2image/run`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (!response.ok) throw new Error(`FusionBrain generation request failed: ${response.status} ${await response.text()}`);
    const created = (await response.json()) as { uuid?: string; status?: string; errorDescription?: string };
    if (!created.uuid) throw new Error(`FusionBrain returned no uuid: ${created.errorDescription || 'unknown error'}`);
    return this.poll(created.uuid);
  }

  private async poll(uuid: string): Promise<string> {
    const timeout = intEnv('FUSIONBRAIN_TIMEOUT_MS', 180000);
    const pollMs = intEnv('FUSIONBRAIN_POLL_MS', 3000);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const response = await fetch(`${API_HOST}/key/api/v1/text2image/status/${uuid}`, { headers: this.headers() });
      if (!response.ok) continue;
      const data = (await response.json()) as { status?: string; images?: string[]; errorDescription?: string; censored?: boolean };
      if (data.status === 'FAIL') throw new Error(`FusionBrain generation failed: ${data.errorDescription || 'unknown error'}`);
      if (data.status === 'DONE') {
        if (data.censored) throw new Error('FusionBrain: результат заблокирован модерацией (censored).');
        if (!data.images?.length) throw new Error('FusionBrain finished without image output.');
        return this.storage.saveBuffer('output', Buffer.from(data.images[0], 'base64'), 'png');
      }
    }
    throw new Error(`FusionBrain generation timed out after ${timeout}ms.`);
  }
}
