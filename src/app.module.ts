import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from './prisma/prisma.service';
import { UsersService } from './users/users.service';
import { BillingService } from './billing/billing.service';
import { StorageService } from './storage/storage.service';
import { DirectorService } from './director/director.service';
import { OpenAIImageProvider } from './providers/openai-image.provider';
import { ComfyUIProvider } from './providers/comfyui.provider';
import { RunwayVideoProvider } from './providers/runway-video.provider';
import { PollinationsImageProvider } from './providers/pollinations-image.provider';
import { FusionBrainImageProvider } from './providers/fusionbrain-image.provider';
import { YandexArtImageProvider } from './providers/yandexart-image.provider';
import { FalAiProvider } from './providers/fal-ai.provider';
import { ModalImageProvider } from './providers/modal-image.provider';
import { ModalVideoProvider } from './providers/modal-video.provider';
import { HfSpaceImageProvider } from './providers/hf-space-image.provider';
import { FfmpegService } from './media/ffmpeg.service';
import { GenerationService } from './generation/generation.service';
import { GenerationProcessor } from './generation/generation.processor';
import { TelegramService } from './telegram/telegram.service';
import { NotifierService } from './telegram/notifier.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
      },
    }),
    BullModule.registerQueue({ name: 'generation' }),
  ],
  providers: [
    PrismaService,
    UsersService,
    BillingService,
    StorageService,
    DirectorService,
    OpenAIImageProvider,
    ComfyUIProvider,
    RunwayVideoProvider,
    PollinationsImageProvider,
    FusionBrainImageProvider,
    YandexArtImageProvider,
    FalAiProvider,
    ModalImageProvider,
    ModalVideoProvider,
    HfSpaceImageProvider,
    FfmpegService,
    GenerationService,
    GenerationProcessor,
    TelegramService,
    NotifierService,
  ],
})
export class AppModule {}
