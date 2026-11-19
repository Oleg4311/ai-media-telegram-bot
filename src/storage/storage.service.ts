import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

@Injectable()
export class StorageService {
  readonly root = process.env.DATA_DIR || path.resolve('data');

  async ensure() {
    await Promise.all(['input', 'output', 'tmp'].map((dir) => fs.mkdir(path.join(this.root, dir), { recursive: true })));
  }

  async saveBuffer(kind: 'input' | 'output' | 'tmp', buffer: Buffer, extension: string): Promise<string> {
    await this.ensure();
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    const filePath = path.join(this.root, kind, `${Date.now()}-${randomUUID()}${ext}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async allocateOutput(extension: string): Promise<string> {
    await this.ensure();
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    return path.join(this.root, 'output', `${Date.now()}-${randomUUID()}${ext}`);
  }

  async allocateTmp(extension: string): Promise<string> {
    await this.ensure();
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    return path.join(this.root, 'tmp', `${Date.now()}-${randomUUID()}${ext}`);
  }

  async download(url: string, extensionHint = 'bin'): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || '';
    const ext = type.includes('video') ? 'mp4' : type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : extensionHint;
    return this.saveBuffer('output', buffer, ext);
  }

  async remove(filePath?: string | null) {
    if (!filePath) return;
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}
