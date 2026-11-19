import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { StorageService } from '../storage/storage.service';
import { intEnv } from '../common/env';
import { translateToEnglish } from '../common/translate';

@Injectable()
export class ComfyUIProvider {
  constructor(private readonly storage: StorageService) {}

  isAvailable() {
    return Boolean(process.env.COMFYUI_URL);
  }

  hasVideoWorkflow() {
    return Boolean(process.env.COMFYUI_VIDEO_WORKFLOW);
  }

  async generateImage(prompt: string, negativePrompt = '', ratio = '1:1'): Promise<string> {
    const workflowPath = process.env.COMFYUI_IMAGE_WORKFLOW || path.resolve('assets/comfyui/sdxl_text_to_image_api.json');
    const [width, height] = ratio === '9:16' ? [768, 1344] : ratio === '16:9' ? [1344, 768] : [1024, 1024];
    return this.runWorkflow(workflowPath, {
      PROMPT: await translateToEnglish(prompt),
      NEGATIVE_PROMPT: negativePrompt || 'blurry, distorted, low quality, artifacts, text, watermark',
      SEED: Math.floor(Math.random() * 2_147_483_647),
      WIDTH: width,
      HEIGHT: height,
      CHECKPOINT: process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors',
      DURATION: 5,
      FPS: 16,
    }, 'image');
  }

  async editImage(inputPath: string, prompt: string, negativePrompt = ''): Promise<string> {
    const workflowPath = process.env.COMFYUI_EDIT_WORKFLOW || path.resolve('assets/comfyui/sdxl_img2img_api.json');
    const uploadedName = await this.uploadInput(inputPath);
    return this.runWorkflow(workflowPath, {
      PROMPT: await translateToEnglish(prompt),
      NEGATIVE_PROMPT: negativePrompt || 'blurry, distorted, low quality, artifacts, text, watermark',
      SEED: Math.floor(Math.random() * 2_147_483_647),
      INPUT_IMAGE: uploadedName,
      CHECKPOINT: process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors',
      WIDTH: 1024,
      HEIGHT: 1024,
      DURATION: 5,
      FPS: 16,
    }, 'image');
  }

  async generateVideo(prompt: string, ratio = '9:16', durationSec = 5, imagePath?: string): Promise<string> {
    const workflowPath = process.env.COMFYUI_VIDEO_WORKFLOW;
    if (!workflowPath) throw new Error('COMFYUI_VIDEO_WORKFLOW is not configured.');
    const [width, height] = ratio === '9:16' ? [720, 1280] : ratio === '16:9' ? [1280, 720] : [960, 960];
    const uploadedName = imagePath ? await this.uploadInput(imagePath) : '';
    return this.runWorkflow(workflowPath, {
      PROMPT: await translateToEnglish(prompt),
      NEGATIVE_PROMPT: 'blurry, low quality, artifacts, morphing, flicker, text, watermark',
      SEED: Math.floor(Math.random() * 2_147_483_647),
      WIDTH: width,
      HEIGHT: height,
      DURATION: Math.min(15, Math.max(3, durationSec)),
      FPS: 16,
      INPUT_IMAGE: uploadedName,
      CHECKPOINT: process.env.COMFYUI_CHECKPOINT || '',
    }, 'video');
  }


  private async uploadInput(filePath: string): Promise<string> {
    const base = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
    const data = await fs.readFile(filePath);
    const fileName = `telegram-${randomUUID()}${path.extname(filePath) || '.png'}`;
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), fileName);
    form.append('overwrite', 'true');
    const response = await fetch(`${base}/upload/image`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(`ComfyUI upload failed: ${response.status} ${await response.text()}`);
    const result = await response.json() as { name?: string; subfolder?: string };
    if (!result.name) throw new Error('ComfyUI upload returned no file name.');
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  }

  private replace(value: any, vars: Record<string, string | number>): any {
    if (Array.isArray(value)) return value.map((v) => this.replace(v, vars));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.replace(v, vars)]));
    }
    if (typeof value !== 'string') return value;
    const exact = value.match(/^\{\{([A-Z0-9_]+)\}\}$/);
    if (exact && exact[1] in vars) return vars[exact[1]];
    return value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  }

  private async runWorkflow(workflowPath: string, vars: Record<string, string | number>, kind: 'image' | 'video'): Promise<string> {
    const base = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
    const raw = JSON.parse(await fs.readFile(workflowPath, 'utf8'));
    const workflow = this.replace(raw, vars);
    const clientId = randomUUID();
    const submit = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!submit.ok) throw new Error(`ComfyUI /prompt failed: ${submit.status} ${await submit.text()}`);
    const result = await submit.json() as { prompt_id?: string };
    if (!result.prompt_id) throw new Error('ComfyUI returned no prompt_id.');

    const timeout = intEnv('COMFYUI_TIMEOUT_MS', 900000);
    const pollMs = intEnv('COMFYUI_POLL_MS', 2000);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const historyRes = await fetch(`${base}/history/${result.prompt_id}`);
      if (!historyRes.ok) continue;
      const history = await historyRes.json() as Record<string, any>;
      const entry = history[result.prompt_id];
      if (!entry?.outputs) continue;
      const file = this.findOutput(entry.outputs, kind);
      if (!file) continue;
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      const view = await fetch(`${base}/view?${query}`);
      if (!view.ok) throw new Error(`ComfyUI /view failed: ${view.status}`);
      const buffer = Buffer.from(await view.arrayBuffer());
      const ext = path.extname(file.filename).slice(1) || (kind === 'video' ? 'mp4' : 'png');
      return this.storage.saveBuffer('output', buffer, ext);
    }
    throw new Error(`ComfyUI generation timed out after ${timeout}ms.`);
  }

  private findOutput(outputs: Record<string, any>, kind: 'image' | 'video') {
    const candidates: any[] = [];
    for (const node of Object.values(outputs)) {
      for (const key of ['videos', 'gifs', 'images']) {
        if (Array.isArray((node as any)?.[key])) candidates.push(...(node as any)[key]);
      }
    }
    if (kind === 'video') {
      return candidates.find((x) => /\.(mp4|webm|gif)$/i.test(x?.filename || '')) || candidates[0];
    }
    return candidates.find((x) => /\.(png|jpe?g|webp)$/i.test(x?.filename || '')) || candidates[0];
  }
}
