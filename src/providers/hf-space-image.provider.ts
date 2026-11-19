import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { intEnv } from '../common/env';

@Injectable()
export class HfSpaceImageProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.HF_SPACE_ZIMAGE_URL);
  }

  private headers() {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
    return headers;
  }

  private dims(ratio: string): [number, number] {
    if (ratio === '9:16') return [768, 1344];
    if (ratio === '16:9') return [1344, 768];
    return [1024, 1024];
  }

  async generate(prompt: string, negativePrompt = '', ratio = '1:1'): Promise<string> {
    if (!this.isAvailable()) throw new Error('HF_SPACE_ZIMAGE_URL is not configured.');
    const base = (process.env.HF_SPACE_ZIMAGE_URL as string).replace(/\/$/, '');
    const [width, height] = this.dims(ratio);

    const submit = await fetch(`${base}/gradio_api/call/predict`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ data: [prompt, negativePrompt, width, height] }),
    });
    if (!submit.ok) throw new Error(`HF Space submit failed: ${submit.status} ${await submit.text()}`);
    const created = (await submit.json()) as { event_id?: string };
    if (!created.event_id) throw new Error('HF Space returned no event_id.');

    const resultRes = await fetch(`${base}/gradio_api/call/predict/${created.event_id}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(intEnv('HF_SPACE_TIMEOUT_MS', 180000)),
    });
    if (!resultRes.ok) throw new Error(`HF Space result fetch failed: ${resultRes.status} ${await resultRes.text()}`);
    const text = await resultRes.text();

    let eventType = '';
    let dataLine: string | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) {
        if (eventType === 'complete') {
          dataLine = line.slice(5).trim();
          break;
        }
        if (eventType === 'error') throw new Error(`HF Space generation failed: ${line.slice(5).trim()}`);
      }
    }
    if (!dataLine) throw new Error('HF Space finished without a "complete" event (possibly out of daily ZeroGPU quota).');

    const parsed = JSON.parse(dataLine) as any[];
    const first = parsed[0];
    let url: string | undefined;
    if (typeof first === 'string') url = first;
    else if (first?.url) url = first.url;
    else if (first?.path) url = `${base}/file=${first.path}`;
    if (!url) throw new Error('HF Space returned no image output.');
    return this.storage.download(url, 'png');
  }
}
