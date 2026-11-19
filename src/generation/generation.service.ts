import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { GenerationMode, GenerationType, User } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

export type CreateGenerationInput = {
  type: GenerationType;
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  durationSec?: number;
  aspectRatio?: string;
  inputPath?: string;
  telegramChatId: number;
  progressMessageId?: number;
  engine?: string;
};

@Injectable()
export class GenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    @InjectQueue('generation') private readonly queue: Queue,
  ) {}

  async create(user: User, input: CreateGenerationInput) {
    const duration = input.durationSec || 0;
    await this.billing.assertCanGenerate(user, input.type, input.mode, duration);
    const cost = this.billing.chargeAmount(user, input.type, input.mode, duration);
    if (cost > 0) await this.billing.charge(user, cost, `${input.type} ${input.mode}`);

    try {
      const generation = await this.prisma.generation.create({
        data: {
          userId: user.id,
          type: input.type,
          mode: input.mode,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          durationSec: input.durationSec,
          aspectRatio: input.aspectRatio,
          inputPath: input.inputPath,
          costCredits: cost,
          metadata: {
            telegramChatId: input.telegramChatId,
            progressMessageId: input.progressMessageId,
            engine: input.engine || 'auto',
          },
        },
      });
      await this.queue.add('generate', { generationId: generation.id }, {
        jobId: generation.id,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      });
      return generation;
    } catch (error) {
      if (cost > 0) await this.billing.refund(user.id, cost, 'Queue/create failure refund');
      throw error;
    }
  }

  async recent(userId: string, take = 10) {
    return this.prisma.generation.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take });
  }
}
