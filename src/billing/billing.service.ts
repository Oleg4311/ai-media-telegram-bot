import { Injectable } from '@nestjs/common';
import { GenerationMode, GenerationType, LedgerType, User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { boolEnv, intEnv } from '../common/env';

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  isUnlimited(user: User): boolean {
    return user.role === UserRole.ADMIN;
  }

  isNoCharge(user: User): boolean {
    return this.isUnlimited(user) || (user.role === UserRole.PREMIUM && boolEnv('PREMIUM_SPONSORED', true));
  }

  chargeAmount(user: User, type: GenerationType, mode: GenerationMode, durationSec = 0): number {
    return this.isNoCharge(user) ? 0 : this.estimateCredits(type, mode, durationSec);
  }

  estimateCredits(type: GenerationType, mode: GenerationMode, durationSec = 0): number {
    if (mode === GenerationMode.FREE) return 0;
    if (type === GenerationType.IMAGE || type === GenerationType.IMAGE_EDIT) {
      return intEnv('COST_IMAGE_PREMIUM', 40);
    }
    const per5 = intEnv('COST_VIDEO_PREMIUM_PER_5S', 220);
    const chunks = Math.max(1, Math.ceil(Math.max(durationSec, 5) / 5));
    const base = chunks * per5 + (type === GenerationType.LONG_VIDEO ? intEnv('COST_LONG_VIDEO_ASSEMBLY', 20) : 0);
    return mode === GenerationMode.CINEMA ? Math.ceil(base * 1.5) : base;
  }

  async assertCanGenerate(user: User, type: GenerationType, mode: GenerationMode, durationSec = 0) {
    if (this.isUnlimited(user)) return;

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    if (mode === GenerationMode.FREE) {
      const isVideo = ([GenerationType.VIDEO, GenerationType.ANIMATE, GenerationType.LONG_VIDEO] as GenerationType[]).includes(type);
      const limit = intEnv(isVideo ? 'FREE_DAILY_VIDEO_LIMIT' : 'FREE_DAILY_IMAGE_LIMIT', isVideo ? 3 : 10);
      const used = await this.prisma.generation.count({
        where: {
          userId: user.id,
          mode: GenerationMode.FREE,
          createdAt: { gte: since },
          type: isVideo ? { in: [GenerationType.VIDEO, GenerationType.ANIMATE, GenerationType.LONG_VIDEO] } : { in: [GenerationType.IMAGE, GenerationType.IMAGE_EDIT] },
        },
      });
      if (used >= limit) throw new Error(`Дневной лимит бесплатного режима исчерпан (${limit}).`);
      return;
    }

    if (user.role === UserRole.PREMIUM) {
      const cap = user.premiumPaidDailyCap ?? intEnv('PREMIUM_DAILY_PAID_LIMIT', 20);
      const used = await this.prisma.generation.count({
        where: { userId: user.id, mode: { in: [GenerationMode.PREMIUM, GenerationMode.CINEMA] }, createdAt: { gte: since } },
      });
      if (used >= cap) throw new Error(`Дневной лимит Premium исчерпан (${cap}).`);
    }

    const cost = this.chargeAmount(user, type, mode, durationSec);
    if (user.credits < cost) throw new Error(`Недостаточно кредитов. Нужно ${cost}, баланс ${user.credits}.`);
  }

  async charge(user: User, amount: number, note: string) {
    if (amount <= 0 || this.isNoCharge(user)) return user;
    return this.prisma.$transaction(async (tx) => {
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (fresh.credits < amount) throw new Error('Недостаточно кредитов.');
      const updated = await tx.user.update({ where: { id: user.id }, data: { credits: { decrement: amount } } });
      await tx.creditLedger.create({
        data: { userId: user.id, type: LedgerType.GENERATION, delta: -amount, balance: updated.credits, note },
      });
      return updated;
    });
  }

  async refund(userId: string, amount: number, note: string) {
    if (amount <= 0) return;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.role === UserRole.ADMIN) return;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: userId }, data: { credits: { increment: amount } } });
      await tx.creditLedger.create({
        data: { userId, type: LedgerType.REFUND, delta: amount, balance: updated.credits, note },
      });
    });
  }

  async addPurchase(userId: string, credits: number, externalId: string, note: string) {
    const existing = await this.prisma.creditLedger.findUnique({ where: { externalId } });
    if (existing) return this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: userId }, data: { credits: { increment: credits } } });
      await tx.creditLedger.create({
        data: { userId, type: LedgerType.PURCHASE, delta: credits, balance: updated.credits, externalId, note },
      });
      return updated;
    });
  }
}
