import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class OpenAIImageProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  private size(ratio: string): '1024x1024' | '1536x1024' | '1024x1536' {
    if (ratio === '16:9') return '1536x1024';
    if (ratio === '9:16') return '1024x1536';
    return '1024x1024';
  }

  private model(cinema: boolean) {
    return cinema
      ? process.env.OPENAI_IMAGE_MODEL_CINEMA || 'gpt-image-2.5-sunburst'
      : process.env.OPENAI_IMAGE_MODEL_PREMIUM || 'gpt-image-2.5-flare';
  }

  private headers() {
    return { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  }

  async generate(prompt: string, ratio = '1:1', cinema = false): Promise<string> {
    if (!this.isAvailable()) throw new Error('OPENAI_API_KEY is not configured.');
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model(cinema),
        prompt,
        size: this.size(ratio),
        quality: cinema ? 'max' : 'high',
        output_format: 'png',
      }),
    });
    if (!response.ok) throw new Error(`OpenAI image generation failed: ${response.status} ${await response.text()}`);
    const result = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
    return this.persist(result);
  }

  async edit(inputPath: string, prompt: string, ratio = '1:1', cinema = false): Promise<string> {
    if (!this.isAvailable()) throw new Error('OPENAI_API_KEY is not configured.');
    const data = await fs.readFile(inputPath);
    const ext = path.extname(inputPath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const form = new FormData();
    form.append('model', this.model(cinema));
    form.append('prompt', prompt);
    form.append('size', this.size(ratio));
    form.append('quality', cinema ? 'max' : 'high');
    form.append('image', new Blob([new Uint8Array(data)], { type: mime }), `input${ext || '.png'}`);

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (!response.ok) throw new Error(`OpenAI image edit failed: ${response.status} ${await response.text()}`);
    const result = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
    return this.persist(result);
  }

  private async persist(result: { data?: Array<{ b64_json?: string; url?: string }> }): Promise<string> {
    const item = result.data?.[0];
    if (item?.b64_json) return this.storage.saveBuffer('output', Buffer.from(item.b64_json, 'base64'), 'png');
    if (item?.url) return this.storage.download(item.url, 'png');
    throw new Error('OpenAI returned no image output.');
  }
}
