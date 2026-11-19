import { Injectable } from '@nestjs/common';
import { Telegram } from 'telegraf';
import { createReadStream } from 'fs';

@Injectable()
export class NotifierService {
  private readonly telegram: Telegram | null;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.telegram = token ? new Telegram(token) : null;
  }

  async progress(chatId: number, messageId: number | undefined, text: string) {
    if (!this.telegram || !messageId) return;
    await this.telegram.editMessageText(chatId, messageId, undefined, text).catch(() => undefined);
  }

  async sendPhoto(chatId: number, filePath: string, caption?: string) {
    if (!this.telegram) return;
    await this.telegram.sendPhoto(chatId, { source: createReadStream(filePath) }, { caption });
  }

  async sendVideo(chatId: number, filePath: string, caption?: string) {
    if (!this.telegram) return;
    await this.telegram.sendVideo(chatId, { source: createReadStream(filePath) }, { caption, supports_streaming: true });
  }

  async sendMessage(chatId: number, text: string) {
    if (!this.telegram) return;
    await this.telegram.sendMessage(chatId, text);
  }
}
