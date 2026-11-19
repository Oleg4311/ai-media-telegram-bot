import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GenerationMode, GenerationType, UserRole } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import { UsersService } from '../users/users.service';
import { DirectorService } from '../director/director.service';
import { GenerationService } from '../generation/generation.service';
import { BillingService } from '../billing/billing.service';
import { StorageService } from '../storage/storage.service';
import { intEnv } from '../common/env';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly bot: Telegraf | null;
  private readonly modes = new Map<string, GenerationMode>();
  private readonly pendingImages = new Map<string, string>();
  private readonly imageEngines = new Map<string, string>();
  private readonly videoEngines = new Map<string, string>();

  private static readonly IMAGE_ENGINES_FREE: Array<{ key: string; label: string }> = [
    { key: 'auto', label: '🤖 Авто' },
    { key: 'comfyui', label: 'ComfyUI' },
    { key: 'pollinations', label: 'Pollinations' },
  ];

  private static readonly IMAGE_ENGINES_PAID: Array<{ key: string; label: string }> = [
    { key: 'auto', label: '🤖 Авто' },
    { key: 'openai', label: 'OpenAI' },
    { key: 'fal', label: 'fal.ai / FLUX' },
    { key: 'fusionbrain', label: 'Kandinsky' },
    { key: 'yandexart', label: 'YandexART' },
    { key: 'zimage', label: 'Z-Image (Modal)' },
    { key: 'qwenimage', label: 'Qwen-Image (Modal)' },
    { key: 'zimage-hf', label: 'Z-Image (HF, без карты)' },
  ];

  private static readonly VIDEO_ENGINES_PAID: Array<{ key: string; label: string }> = [
    { key: 'auto', label: '🤖 Авто' },
    { key: 'runway', label: 'Runway' },
    { key: 'fal', label: 'fal.ai / Kling' },
    { key: 'modal-wan', label: 'Wan (Modal)' },
  ];

  constructor(
    private readonly users: UsersService,
    private readonly director: DirectorService,
    private readonly generations: GenerationService,
    private readonly billing: BillingService,
    private readonly storage: StorageService,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.bot = token ? new Telegraf(token) : null;
  }

  async onModuleInit() {
    await this.storage.ensure();
    if (!this.bot) {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set. Bot polling is disabled.');
      return;
    }
    this.registerHandlers();
    const bot = this.bot;
    bot
      .launch({ dropPendingUpdates: false }, () => this.logger.log('Telegram bot started'))
      .catch((error) => this.logger.error('Telegram bot polling stopped with error', error as any));
  }

  onModuleDestroy() {
    this.bot?.stop('shutdown');
  }

  private registerHandlers() {
    const bot = this.bot!;

    bot.start(async (ctx) => {
      const user = await this.ensureUser(ctx);
      const mode = this.defaultMode(user.role);
      this.modes.set(String(ctx.from.id), mode);
      await ctx.reply(
        `AI Media Studio\n\nПросто напиши, что хочешь получить. Можно прислать фото и написать: «оживи на 20 секунд» или «замени фон».\n\nТвой ID: ${ctx.from.id}\nРоль: ${user.role}\nБаланс: ${user.role === UserRole.ADMIN ? '∞' : user.credits} credits\nТекущий режим: ${mode}`,
        this.mainKeyboard(mode),
      );
    });

    bot.command('help', async (ctx) => {
      await ctx.reply(
        'Примеры:\n\n• Девушка на берегу моря на закате, фотореализм\n• Ролик 30 секунд: Porsche ночью в Токио, вертикально\n• Пришли фото + «оживи на 20 секунд, ветер в волосах»\n• Пришли фото + «замени фон на Париж ночью»\n\n/free — бесплатный локальный режим\n/premium — платные AI-модели\n/cinema — максимальный режим\n/engine — выбрать конкретный движок генерации (OpenAI, fal.ai, Kandinsky, YandexART, Runway...)\n/balance — баланс\n/buy — купить credits\n/history — последние работы',
      );
    });

    bot.command('free', async (ctx) => this.setMode(ctx, GenerationMode.FREE));
    bot.command('premium', async (ctx) => this.setMode(ctx, GenerationMode.PREMIUM));
    bot.command('cinema', async (ctx) => this.setMode(ctx, GenerationMode.CINEMA));

    bot.command('engine', async (ctx) => {
      const user = await this.ensureUser(ctx);
      const mode = this.modes.get(String(ctx.from.id)) || this.defaultMode(user.role);
      await ctx.reply(this.engineMenuText(ctx.from.id, mode), this.engineKeyboard(ctx.from.id, mode));
    });

    bot.command('balance', async (ctx) => {
      let user = await this.ensureUser(ctx);
      user = await this.users.normalizePremium(user);
      await ctx.reply(`Роль: ${user.role}\nБаланс: ${user.role === UserRole.ADMIN ? '∞' : user.credits} credits\nPremium до: ${user.premiumUntil?.toLocaleString() || '—'}\nТвой Telegram ID: ${ctx.from.id}`);
    });

    bot.command('history', async (ctx) => {
      const user = await this.ensureUser(ctx);
      const items = await this.generations.recent(user.id, 8);
      if (!items.length) return void (await ctx.reply('История пока пустая.'));
      await ctx.reply(items.map((x) => `${x.status === 'SUCCEEDED' ? '✅' : x.status === 'FAILED' ? '❌' : '⏳'} ${x.type} / ${x.mode} / ${x.costCredits} cr\n${x.prompt.slice(0, 80)}\n${x.id}`).join('\n\n'));
    });

    bot.command('buy', async (ctx) => {
      await this.ensureUser(ctx);
      await ctx.reply('Выбери пакет:', Markup.inlineKeyboard([
        [Markup.button.callback(`${intEnv('STARS_PACK_1_CREDITS', 500)} credits — ${intEnv('STARS_PACK_1_STARS', 250)} ⭐`, 'buy:1')],
        [Markup.button.callback(`${intEnv('STARS_PACK_2_CREDITS', 2300)} credits — ${intEnv('STARS_PACK_2_STARS', 1000)} ⭐`, 'buy:2')],
        [Markup.button.callback(`${intEnv('STARS_PACK_3_CREDITS', 6500)} credits — ${intEnv('STARS_PACK_3_STARS', 2500)} ⭐`, 'buy:3')],
      ]));
    });

    bot.command('admin', async (ctx) => {
      const user = await this.ensureUser(ctx);
      if (user.role !== UserRole.ADMIN) return void (await ctx.reply('Команда доступна только администратору.'));
      const text = 'text' in ctx.message ? ctx.message.text : '/admin';
      const [, action, target, arg1, arg2] = text.trim().split(/\s+/);
      try {
        if (!action) {
          return void (await ctx.reply('Admin:\n/admin premium <telegramId> [days=30] [dailyCap=20]\n/admin free <telegramId>\n/admin credits <telegramId> <amount>\n/admin user <telegramId>'));
        }
        if (action === 'premium' && target) {
          const updated = await this.users.setPremium(target, Number(arg1 || 30), arg2 ? Number(arg2) : undefined);
          return void (await ctx.reply(`✅ ${target} → PREMIUM до ${updated.premiumUntil?.toLocaleString()}\nБаланс: ${updated.credits}`));
        }
        if (action === 'free' && target) {
          const updated = await this.users.setFree(target);
          return void (await ctx.reply(`✅ ${target} → ${updated.role}`));
        }
        if (action === 'credits' && target && arg1) {
          const updated = await this.users.addCredits(target, Number(arg1));
          return void (await ctx.reply(`✅ Баланс ${target}: ${updated.credits}`));
        }
        if (action === 'user' && target) {
          const targetUser = await this.users.getByTelegramId(target);
          return void (await ctx.reply(targetUser ? `ID: ${target}\nRole: ${targetUser.role}\nCredits: ${targetUser.credits}\nPremium until: ${targetUser.premiumUntil || '—'}\nDaily paid cap: ${targetUser.premiumPaidDailyCap || '—'}` : 'Пользователь не найден. Он должен сначала нажать /start.'));
        }
        await ctx.reply('Неизвестная admin-команда. /admin — справка.');
      } catch (error: any) {
        await ctx.reply(`Ошибка: ${error?.message || error}`);
      }
    });

    bot.action(/^mode:(FREE|PREMIUM|CINEMA)$/, async (ctx) => {
      const mode = ctx.match[1] as GenerationMode;
      await this.ensureUser(ctx);
      this.modes.set(String(ctx.from.id), mode);
      await ctx.answerCbQuery(`Режим: ${mode}`);
      await ctx.editMessageReplyMarkup(this.mainKeyboard(mode).reply_markup).catch(() => undefined);
    });

    bot.action(/^engine:(image|video):([a-z-]+)$/, async (ctx) => {
      const [, kind, key] = ctx.match;
      await this.ensureUser(ctx);
      const id = String(ctx.from.id);
      if (kind === 'image') this.imageEngines.set(id, key);
      else this.videoEngines.set(id, key);
      await ctx.answerCbQuery(`Движок (${kind}): ${key}`);
      const user = await this.ensureUser(ctx);
      const mode = this.modes.get(id) || this.defaultMode(user.role);
      await ctx.editMessageText(this.engineMenuText(ctx.from.id, mode), this.engineKeyboard(ctx.from.id, mode)).catch(() => undefined);
    });

    bot.action('engine_menu', async (ctx) => {
      const user = await this.ensureUser(ctx);
      const mode = this.modes.get(String(ctx.from.id)) || this.defaultMode(user.role);
      await ctx.answerCbQuery();
      await ctx.reply(this.engineMenuText(ctx.from.id, mode), this.engineKeyboard(ctx.from.id, mode));
    });

    bot.action('shop', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('Выбери пакет:', Markup.inlineKeyboard([
        [Markup.button.callback(`${intEnv('STARS_PACK_1_CREDITS', 500)} credits — ${intEnv('STARS_PACK_1_STARS', 250)} ⭐`, 'buy:1')],
        [Markup.button.callback(`${intEnv('STARS_PACK_2_CREDITS', 2300)} credits — ${intEnv('STARS_PACK_2_STARS', 1000)} ⭐`, 'buy:2')],
        [Markup.button.callback(`${intEnv('STARS_PACK_3_CREDITS', 6500)} credits — ${intEnv('STARS_PACK_3_STARS', 2500)} ⭐`, 'buy:3')],
      ]));
    });

    bot.action(/^buy:(1|2|3)$/, async (ctx) => {
      await this.ensureUser(ctx);
      const index = ctx.match[1];
      const stars = intEnv(`STARS_PACK_${index}_STARS`, index === '1' ? 250 : index === '2' ? 1000 : 2500);
      const credits = intEnv(`STARS_PACK_${index}_CREDITS`, index === '1' ? 500 : index === '2' ? 2300 : 6500);
      const payload = `credits:${credits}:${Date.now()}:${ctx.from.id}`;
      await ctx.answerCbQuery();
      await ctx.telegram.callApi('sendInvoice', {
        chat_id: ctx.chat!.id,
        title: `${credits} AI Credits`,
        description: 'Credits for premium image and video generation',
        payload,
        currency: 'XTR',
        prices: [{ label: `${credits} credits`, amount: stars }],
      } as any);
    });

    bot.on('pre_checkout_query', async (ctx) => {
      await ctx.answerPreCheckoutQuery(true);
    });

    bot.on('message', async (ctx, next) => {
      const message: any = ctx.message;
      if (!message?.successful_payment) return next();
      const user = await this.ensureUser(ctx);
      const payment = message.successful_payment;
      const match = String(payment.invoice_payload || '').match(/^credits:(\d+):/);
      if (!match) return void (await ctx.reply('Платёж получен, но payload не распознан. Обратись к администратору.'));
      const credits = Number(match[1]);
      const updated = await this.billing.addPurchase(user.id, credits, payment.telegram_payment_charge_id, `Telegram Stars: ${payment.total_amount} XTR`);
      await ctx.reply(`✅ Оплата получена. Начислено ${credits} credits.\nБаланс: ${updated.credits}`);
    });

    bot.on('photo', async (ctx) => {
      const user = await this.ensureUser(ctx);
      const photo = ctx.message.photo.at(-1)!;
      const inputPath = await this.downloadTelegramFile(ctx, photo.file_id, 'jpg');
      const caption = ctx.message.caption?.trim();
      if (!caption) {
        this.pendingImages.set(String(ctx.from.id), inputPath);
        return void (await ctx.reply('Фото принято. Теперь напиши, что с ним сделать: например «оживи на 20 секунд» или «замени фон на ночной Париж».'));
      }
      await this.handleRequest(ctx, user, caption, inputPath);
    });

    bot.on('text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      const user = await this.ensureUser(ctx);
      const inputPath = this.pendingImages.get(String(ctx.from.id));
      if (inputPath) this.pendingImages.delete(String(ctx.from.id));
      await this.handleRequest(ctx, user, ctx.message.text.trim(), inputPath);
    });

    bot.catch((error, ctx) => {
      this.logger.error(`Telegram update failed: ${ctx.update.update_id}`, error as any);
    });
  }

  private async handleRequest(ctx: any, user: any, text: string, inputPath?: string) {
    try {
      user = await this.users.normalizePremium(user);
      const plan = await this.director.plan(text, Boolean(inputPath));
      const mode = this.modes.get(String(ctx.from.id)) || this.defaultMode(user.role);
      let type: GenerationType;
      if (plan.kind === 'image') type = GenerationType.IMAGE;
      else if (plan.kind === 'edit') type = inputPath ? GenerationType.IMAGE_EDIT : GenerationType.IMAGE;
      else if (plan.kind === 'animate') type = plan.durationSec > 10 ? GenerationType.LONG_VIDEO : GenerationType.ANIMATE;
      else type = plan.durationSec > 10 ? GenerationType.LONG_VIDEO : GenerationType.VIDEO;

      const isVideoType = ([GenerationType.VIDEO, GenerationType.ANIMATE, GenerationType.LONG_VIDEO] as GenerationType[]).includes(type);
      const engine = (isVideoType ? this.videoEngines.get(String(ctx.from.id)) : this.imageEngines.get(String(ctx.from.id))) || 'auto';

      const cost = this.billing.chargeAmount(user, type, mode, plan.durationSec);
      const status = await ctx.reply(`🧠 Запрос понят\nТип: ${type}\nРежим: ${mode}\nДвижок: ${engine}\nДлительность: ${type.includes('VIDEO') || type === GenerationType.ANIMATE ? `${plan.durationSec} сек` : '—'}\nФормат: ${plan.aspectRatio}\nСтоимость: ${user.role === UserRole.ADMIN ? '∞ / без списаний' : user.role === UserRole.PREMIUM && cost === 0 ? '0 credits (Premium)' : `${cost} credits`}\n\n⏳ Ставлю в очередь...`);

      await this.generations.create(user, {
        type,
        mode,
        prompt: plan.prompt,
        negativePrompt: plan.negativePrompt,
        durationSec: isVideoType ? plan.durationSec : undefined,
        aspectRatio: plan.aspectRatio,
        inputPath,
        telegramChatId: ctx.chat.id,
        progressMessageId: status.message_id,
        engine,
      });
    } catch (error: any) {
      await ctx.reply(`❌ ${error?.message || error}`);
    }
  }

  private async ensureUser(ctx: any) {
    return this.users.upsertTelegramUser({
      telegramId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
    });
  }

  private defaultMode(role: UserRole) {
    if (role === UserRole.ADMIN) return GenerationMode.CINEMA;
    if (role === UserRole.PREMIUM) return GenerationMode.PREMIUM;
    return GenerationMode.FREE;
  }

  private async setMode(ctx: any, mode: GenerationMode) {
    await this.ensureUser(ctx);
    this.modes.set(String(ctx.from.id), mode);
    await ctx.reply(`Режим переключён: ${mode}`, this.mainKeyboard(mode));
  }

  private mainKeyboard(active: GenerationMode) {
    const label = (mode: GenerationMode, text: string) => `${active === mode ? '✅ ' : ''}${text}`;
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(label(GenerationMode.FREE, '🆓 FREE'), 'mode:FREE'),
        Markup.button.callback(label(GenerationMode.PREMIUM, '✨ PREMIUM'), 'mode:PREMIUM'),
        Markup.button.callback(label(GenerationMode.CINEMA, '🎬 CINEMA'), 'mode:CINEMA'),
      ],
      [Markup.button.callback('💎 Купить credits', 'shop'), Markup.button.callback('⚙️ Движок', 'engine_menu')],
    ]);
  }

  private engineMenuText(telegramId: number, mode: GenerationMode): string {
    const id = String(telegramId);
    const image = this.imageEngines.get(id) || 'auto';
    if (mode === GenerationMode.FREE) {
      return `Выбор движка для FREE\n\n🖼 Картинки: ${image}\n\n«🤖 Авто» — сам выберет ComfyUI (если настроен) или бесплатный Pollinations.`;
    }
    const video = this.videoEngines.get(id) || 'auto';
    return `Выбор движка для ${mode}\n\n🖼 Картинки: ${image}\n🎬 Видео: ${video}\n\n«🤖 Авто» — по приоритету, первый настроенный ключ.\nЕсли у выбранного движка нет ключа в .env — генерация вернёт ошибку с точным указанием, что настроить.`;
  }

  private engineKeyboard(telegramId: number, mode: GenerationMode) {
    const id = String(telegramId);
    const activeImage = this.imageEngines.get(id) || 'auto';
    const imageOptions = mode === GenerationMode.FREE ? TelegramService.IMAGE_ENGINES_FREE : TelegramService.IMAGE_ENGINES_PAID;
    const label = (active: string, key: string, text: string) => `${active === key ? '✅ ' : ''}${text}`;

    const imageButtons = imageOptions.map((o) => Markup.button.callback(label(activeImage, o.key, o.label), `engine:image:${o.key}`));
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < imageButtons.length; i += 3) rows.push(imageButtons.slice(i, i + 3));

    if (mode !== GenerationMode.FREE) {
      const activeVideo = this.videoEngines.get(id) || 'auto';
      rows.push(TelegramService.VIDEO_ENGINES_PAID.map((o) => Markup.button.callback(label(activeVideo, o.key, o.label), `engine:video:${o.key}`)));
    }

    return Markup.inlineKeyboard(rows);
  }

  private async downloadTelegramFile(ctx: any, fileId: string, extension: string) {
    const url = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(url.href);
    if (!response.ok) throw new Error(`Не удалось скачать файл из Telegram: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.storage.saveBuffer('input', buffer, extension);
  }
}
