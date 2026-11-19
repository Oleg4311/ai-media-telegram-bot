import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { GenerationMode, GenerationStatus, GenerationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OpenAIImageProvider } from '../providers/openai-image.provider';
import { ComfyUIProvider } from '../providers/comfyui.provider';
import { RunwayVideoProvider } from '../providers/runway-video.provider';
import { PollinationsImageProvider } from '../providers/pollinations-image.provider';
import { FusionBrainImageProvider } from '../providers/fusionbrain-image.provider';
import { YandexArtImageProvider } from '../providers/yandexart-image.provider';
import { FalAiProvider } from '../providers/fal-ai.provider';
import { ModalImageProvider } from '../providers/modal-image.provider';
import { ModalVideoProvider } from '../providers/modal-video.provider';
import { HfSpaceImageProvider } from '../providers/hf-space-image.provider';
import { FfmpegService } from '../media/ffmpeg.service';
import { DirectorService } from '../director/director.service';
import { BillingService } from '../billing/billing.service';
import { NotifierService } from '../telegram/notifier.service';

@Processor('generation', { concurrency: 2 })
export class GenerationProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openaiImage: OpenAIImageProvider,
    private readonly comfy: ComfyUIProvider,
    private readonly runway: RunwayVideoProvider,
    private readonly pollinations: PollinationsImageProvider,
    private readonly fusionBrain: FusionBrainImageProvider,
    private readonly yandexArt: YandexArtImageProvider,
    private readonly falAi: FalAiProvider,
    private readonly modalImage: ModalImageProvider,
    private readonly modalVideo: ModalVideoProvider,
    private readonly hfSpaceImage: HfSpaceImageProvider,
    private readonly ffmpeg: FfmpegService,
    private readonly director: DirectorService,
    private readonly billing: BillingService,
    private readonly notifier: NotifierService,
  ) {
    super();
  }

  async process(job: Job<{ generationId: string }>) {
    const generation = await this.prisma.generation.findUnique({
      where: { id: job.data.generationId },
      include: { user: true },
    });
    if (!generation) throw new Error('Generation not found');
    const meta = (generation.metadata || {}) as { telegramChatId?: number; progressMessageId?: number };
    const chatId = Number(meta.telegramChatId);

    await this.prisma.generation.update({
      where: { id: generation.id },
      data: { status: GenerationStatus.RUNNING, startedAt: new Date() },
    });
    await this.notifier.progress(chatId, meta.progressMessageId, '🎬 Запущено\n⏳ Подготавливаю генерацию...');

    try {
      let outputPath: string;
      let provider: string;

      if (([GenerationType.IMAGE, GenerationType.IMAGE_EDIT] as GenerationType[]).includes(generation.type)) {
        const result = await this.processImage(generation);
        outputPath = result.path;
        provider = result.provider;
      } else {
        const result = await this.processVideo(generation, async (text) => {
          await this.notifier.progress(chatId, meta.progressMessageId, text);
        });
        outputPath = result.path;
        provider = result.provider;
      }

      await this.prisma.generation.update({
        where: { id: generation.id },
        data: { status: GenerationStatus.SUCCEEDED, outputPath, provider, finishedAt: new Date() },
      });

      if (([GenerationType.IMAGE, GenerationType.IMAGE_EDIT] as GenerationType[]).includes(generation.type)) {
        await this.notifier.sendPhoto(chatId, outputPath, `✅ Готово\nРежим: ${generation.mode}\nID: ${generation.id}`);
      } else {
        const telegramCopy = await this.ffmpeg.compressForTelegram(outputPath);
        await this.notifier.sendVideo(chatId, telegramCopy, `✅ Готово\nРежим: ${generation.mode}\n${generation.durationSec || ''} сек\nID: ${generation.id}`);
      }
      await this.notifier.progress(chatId, meta.progressMessageId, '✅ Генерация завершена. Результат отправлен ниже.');
      return { outputPath };
    } catch (error: any) {
      const message = error?.message || String(error);
      const attempts = Number(job.opts.attempts || 1);
      const finalAttempt = job.attemptsMade + 1 >= attempts;
      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          status: finalAttempt ? GenerationStatus.FAILED : GenerationStatus.QUEUED,
          error: message.slice(0, 5000),
          finishedAt: finalAttempt ? new Date() : null,
        },
      });
      if (finalAttempt && generation.costCredits > 0) {
        await this.billing.refund(generation.userId, generation.costCredits, `Generation ${generation.id} failed`);
      }
      await this.notifier.progress(
        chatId,
        meta.progressMessageId,
        finalAttempt
          ? `❌ Ошибка генерации\n${message.slice(0, 800)}\nКредиты возвращены.`
          : `⚠️ Первая попытка не удалась. Автоматически пробую ещё раз...`,
      );
      throw error;
    }
  }

  private getEngine(generation: any): string {
    return ((generation.metadata || {}) as { engine?: string }).engine || 'auto';
  }

  private async runEngineChain(
    engine: string,
    providers: Array<{ key: string; label: string; available: () => boolean; run: () => Promise<{ path: string; provider: string }> }>,
    noneAvailableMessage: string,
  ): Promise<{ path: string; provider: string }> {
    if (engine !== 'auto') {
      const chosen = providers.find((p) => p.key === engine);
      if (!chosen) throw new Error(`Неизвестный движок "${engine}".`);
      if (!chosen.available()) throw new Error(`Выбран движок ${chosen.label}, но он не настроен.`);
      return chosen.run();
    }
    for (const p of providers) {
      if (p.available()) return p.run();
    }
    throw new Error(noneAvailableMessage);
  }

  private freeImageProviders(generation: any, ratio: string) {
    return [
      {
        key: 'comfyui',
        label: 'ComfyUI (COMFYUI_URL)',
        available: () => this.comfy.isAvailable(),
        run: async () => ({ path: await this.comfy.generateImage(generation.prompt, generation.negativePrompt || '', ratio), provider: 'comfyui-local' }),
      },
      {
        key: 'pollinations',
        label: 'Pollinations (бесплатно, без ключа)',
        available: () => this.pollinations.isAvailable(),
        run: async () => ({ path: await this.pollinations.generate(generation.prompt, generation.negativePrompt || '', ratio), provider: 'pollinations-free' }),
      },
    ];
  }

  private premiumImageProviders(generation: any, ratio: string) {
    return [
      {
        key: 'openai',
        label: 'OpenAI (OPENAI_API_KEY)',
        available: () => this.openaiImage.isAvailable(),
        run: async () => ({
          path: await this.openaiImage.generate(generation.prompt, ratio, generation.mode === GenerationMode.CINEMA),
          provider: generation.mode === GenerationMode.CINEMA ? 'openai-sunburst' : 'openai-flare',
        }),
      },
      {
        key: 'fal',
        label: 'fal.ai / FLUX (FAL_KEY)',
        available: () => this.falAi.isAvailable(),
        run: async () => ({ path: await this.falAi.generateImage(generation.prompt, ratio), provider: 'fal-flux' }),
      },
      {
        key: 'fusionbrain',
        label: 'Kandinsky (FUSIONBRAIN_API_KEY+SECRET)',
        available: () => this.fusionBrain.isAvailable(),
        run: async () => ({ path: await this.fusionBrain.generate(generation.prompt, generation.negativePrompt || '', ratio), provider: 'fusionbrain-kandinsky' }),
      },
      {
        key: 'yandexart',
        label: 'YandexART (YANDEX_API_KEY+FOLDER_ID)',
        available: () => this.yandexArt.isAvailable(),
        run: async () => ({ path: await this.yandexArt.generate(generation.prompt, ratio), provider: 'yandexart' }),
      },
      {
        key: 'zimage',
        label: 'Z-Image-Turbo on Modal (MODAL_ZIMAGE_URL)',
        available: () => this.modalImage.isZImageAvailable(),
        run: async () => ({ path: await this.modalImage.generateZImage(generation.prompt, generation.negativePrompt || '', ratio), provider: 'modal-zimage' }),
      },
      {
        key: 'qwenimage',
        label: 'Qwen-Image on Modal (MODAL_QWEN_IMAGE_URL)',
        available: () => this.modalImage.isQwenImageAvailable(),
        run: async () => ({ path: await this.modalImage.generateQwenImage(generation.prompt, generation.negativePrompt || '', ratio), provider: 'modal-qwen-image' }),
      },
      {
        key: 'zimage-hf',
        label: 'Z-Image-Turbo on HF Spaces (HF_SPACE_ZIMAGE_URL, no card needed but tiny 5min/day quota)',
        available: () => this.hfSpaceImage.isAvailable(),
        run: async () => ({ path: await this.hfSpaceImage.generate(generation.prompt, generation.negativePrompt || '', ratio), provider: 'hf-space-zimage' }),
      },
    ];
  }

  private async processImage(generation: any): Promise<{ path: string; provider: string }> {
    const ratio = generation.aspectRatio || '1:1';
    const engine = this.getEngine(generation);

    if (generation.mode === GenerationMode.FREE) {
      if (generation.type === GenerationType.IMAGE_EDIT && generation.inputPath) {
        if (!this.comfy.isAvailable()) {
          throw new Error('Бесплатное редактирование фото требует локальный ComfyUI. Укажи COMFYUI_URL в .env.');
        }
        return { path: await this.comfy.editImage(generation.inputPath, generation.prompt, generation.negativePrompt || ''), provider: 'comfyui-local-img2img' };
      }
      return this.runEngineChain(
        engine,
        this.freeImageProviders(generation, ratio),
        'Бесплатная AI-генерация требует локальный ComfyUI (COMFYUI_URL) либо доступный Pollinations.',
      );
    }

    if (generation.type === GenerationType.IMAGE_EDIT && generation.inputPath) {
      if (!this.openaiImage.isAvailable()) throw new Error('Для Premium-редактирования фото нужен OPENAI_API_KEY (другие провайдеры редактирование не поддерживают).');
      return { path: await this.openaiImage.edit(generation.inputPath, generation.prompt, ratio, generation.mode === GenerationMode.CINEMA), provider: generation.mode === GenerationMode.CINEMA ? 'openai-sunburst' : 'openai-flare' };
    }

    return this.runEngineChain(
      engine,
      this.premiumImageProviders(generation, ratio),
      'Для Premium-картинок нужен один из ключей: OPENAI_API_KEY, FAL_KEY (fal.ai), FUSIONBRAIN_API_KEY+FUSIONBRAIN_SECRET_KEY (Kandinsky), YANDEX_API_KEY+YANDEX_FOLDER_ID (YandexART), либо MODAL_ZIMAGE_URL/MODAL_QWEN_IMAGE_URL (свой деплой на Modal).',
    );
  }

  private async generateReferenceImage(prompt: string, ratio: string, cinema: boolean): Promise<string | undefined> {
    const refPrompt = `${prompt}. Cinematic master reference frame, consistent character/product design, clean composition.`;
    if (this.openaiImage.isAvailable()) return this.openaiImage.generate(refPrompt, ratio, cinema);
    if (this.falAi.isAvailable()) return this.falAi.generateImage(refPrompt, ratio);
    if (this.fusionBrain.isAvailable()) return this.fusionBrain.generate(refPrompt, '', ratio);
    if (this.yandexArt.isAvailable()) return this.yandexArt.generate(refPrompt, ratio);
    if (this.modalImage.isZImageAvailable()) return this.modalImage.generateZImage(refPrompt, '', ratio);
    if (this.modalImage.isQwenImageAvailable()) return this.modalImage.generateQwenImage(refPrompt, '', ratio);
    if (this.hfSpaceImage.isAvailable()) return this.hfSpaceImage.generate(refPrompt, '', ratio);
    return undefined;
  }

  private async processVideo(generation: any, progress: (text: string) => Promise<void>): Promise<{ path: string; provider: string }> {
    const ratio = generation.aspectRatio || '9:16';
    const duration = Math.min(180, Math.max(5, generation.durationSec || 10));
    const engine = this.getEngine(generation);

    if (generation.mode === GenerationMode.FREE) {
      if (this.comfy.hasVideoWorkflow()) {
        await progress('🎬 Бесплатный локальный AI-video\n⏳ ComfyUI генерирует видео...');
        const path = await this.comfy.generateVideo(generation.prompt, ratio, duration, generation.inputPath || undefined);
        return { path, provider: 'comfyui-local-video' };
      }

      let imagePath = generation.inputPath as string | undefined;
      if (!imagePath) {
        if (this.comfy.isAvailable()) {
          await progress('🖼 Бесплатный режим\n✅ План готов\n⏳ Создаю ключевой кадр локально...');
          imagePath = await this.comfy.generateImage(generation.prompt, generation.negativePrompt || '', ratio);
        } else if (this.pollinations.isAvailable()) {
          await progress('🖼 Бесплатный режим\n✅ План готов\n⏳ Создаю ключевой кадр (pollinations.ai)...');
          imagePath = await this.pollinations.generate(generation.prompt, generation.negativePrompt || '', ratio);
        } else {
          throw new Error('Для бесплатного text→video нужен локальный ComfyUI. Для photo→animation достаточно прислать фото.');
        }
      }
      await progress('🎞 Бесплатный режим\n✅ Ключевой кадр\n⏳ Делаю длинную плавную анимацию FFmpeg...');
      return { path: await this.ffmpeg.animateImage(imagePath, duration, ratio, generation.prompt), provider: 'free-local-motion' };
    }

    const videoProviders: Record<string, { label: string; available: () => boolean }> = {
      runway: { label: 'Runway (RUNWAYML_API_SECRET)', available: () => this.runway.isAvailable() },
      fal: { label: 'fal.ai / Kling (FAL_KEY)', available: () => this.falAi.isAvailable() },
      'modal-wan': { label: 'Wan on Modal (MODAL_WAN_VIDEO_URL)', available: () => this.modalVideo.isAvailable() },
    };

    let videoEngine: string;
    if (engine === 'auto') {
      videoEngine = Object.keys(videoProviders).find((key) => videoProviders[key].available()) || '';
      if (!videoEngine) {
        throw new Error('Для Premium-video нужен один из ключей: RUNWAYML_API_SECRET, FAL_KEY (fal.ai + Kling), либо MODAL_WAN_VIDEO_URL (свой деплой Wan на Modal).');
      }
    } else if (videoProviders[engine]) {
      if (!videoProviders[engine].available()) throw new Error(`Выбран движок ${videoProviders[engine].label}, но он не настроен.`);
      videoEngine = engine;
    } else {
      throw new Error(`Неизвестный видео-движок "${engine}".`);
    }

    const plan = await this.director.plan(`${generation.prompt}. Make a coherent ${duration} second cinematic video.`, Boolean(generation.inputPath));
    let referencePath = generation.inputPath as string | undefined;
    if (!referencePath) {
      await progress('🎬 Premium\n✅ Сценарий готов\n⏳ Создаю единый reference-кадр для стабильности персонажа...');
      referencePath = await this.generateReferenceImage(generation.prompt, ratio, generation.mode === GenerationMode.CINEMA);
    }
    if (videoEngine !== 'runway' && !referencePath) {
      throw new Error(`${videoProviders[videoEngine].label} работает только image-to-video: не удалось создать reference-кадр (нужен ключ хотя бы одного image-провайдера).`);
    }

    const clipSeconds = videoEngine === 'runway'
      ? (Number(process.env.RUNWAY_CLIP_SECONDS || 5) >= 10 ? 10 : 5)
      : (duration >= 8 ? 10 : 5);
    const clipCount = Math.max(1, Math.ceil(duration / clipSeconds));
    const clips: string[] = [];
    for (let i = 0; i < clipCount; i++) {
      const scene = plan.scenes[i % Math.max(plan.scenes.length, 1)];
      const prompt = `${scene?.prompt || generation.prompt}. ${scene?.camera || ''}. Clip ${i + 1}/${clipCount}. Maintain exact subject identity, wardrobe/product design, environment, lighting and color palette. Natural motion, no morphing, no sudden cuts.`;
      await progress(`🎬 Premium (${videoEngine})\n✅ Сценарий\n${referencePath ? '✅ Reference-кадр\n' : ''}⏳ Сцена ${i + 1}/${clipCount}`);
      if (videoEngine === 'runway') {
        clips.push(await this.runway.generateClip({ prompt, ratio, durationSec: clipSeconds, imagePath: referencePath }));
      } else if (videoEngine === 'fal') {
        clips.push(await this.falAi.animateImage(referencePath as string, prompt, clipSeconds));
      } else {
        clips.push(await this.modalVideo.animateImage(referencePath as string, prompt, clipSeconds));
      }
    }
    await progress(`🎬 Premium (${videoEngine})\n✅ Все сцены: ${clips.length}\n⏳ Монтаж и нормализация видео...`);
    return { path: await this.ffmpeg.concat(clips, ratio, duration), provider: videoEngine };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    console.error('Generation job failed', job?.id, error.message);
  }
}
