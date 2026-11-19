import { Injectable } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { adminIds, intEnv } from '../common/env';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertTelegramUser(input: {
    telegramId: number | string;
    username?: string;
    firstName?: string;
  }): Promise<User> {
    const telegramId = BigInt(input.telegramId);
    const isAdmin = adminIds().has(String(input.telegramId));
    const existing = await this.prisma.user.findUnique({ where: { telegramId } });

    if (!existing) {
      return this.prisma.user.create({
        data: {
          telegramId,
          username: input.username,
          firstName: input.firstName,
          role: isAdmin ? UserRole.ADMIN : UserRole.FREE,
          credits: isAdmin ? 1_000_000_000 : 0,
        },
      });
    }

    const desiredRole = isAdmin ? UserRole.ADMIN : existing.role;
    if (
      existing.username !== input.username ||
      existing.firstName !== input.firstName ||
      existing.role !== desiredRole
    ) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          username: input.username,
          firstName: input.firstName,
          role: desiredRole,
        },
      });
    }
    return existing;
  }

  async getByTelegramId(telegramId: number | string) {
    return this.prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  }

  async setPremium(telegramId: string, days = 30, dailyPaidCap?: number) {
    const user = await this.getByTelegramId(telegramId);
    if (!user) throw new Error('User not found. The user must start the bot first.');
    if (user.role === UserRole.ADMIN) return user;

    const until = new Date(Date.now() + days * 86_400_000);
    const included = intEnv('PREMIUM_INCLUDED_CREDITS', 3000);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          role: UserRole.PREMIUM,
          premiumUntil: until,
          premiumPaidDailyCap: dailyPaidCap ?? intEnv('PREMIUM_DAILY_PAID_LIMIT', 20),
          credits: { increment: included },
        },
      });
      await tx.creditLedger.create({
        data: {
          userId: user.id,
          type: 'PREMIUM_GRANT',
          delta: included,
          balance: updated.credits,
          note: `Premium granted for ${days} days`,
        },
      });
      return updated;
    });
  }

  async setFree(telegramId: string) {
    const user = await this.getByTelegramId(telegramId);
    if (!user) throw new Error('User not found.');
    if (user.role === UserRole.ADMIN) throw new Error('Admin role is controlled by ADMIN_TELEGRAM_IDS.');
    return this.prisma.user.update({
      where: { id: user.id },
      data: { role: UserRole.FREE, premiumUntil: null, premiumPaidDailyCap: null },
    });
  }

  async addCredits(telegramId: string, amount: number, note = 'Admin adjustment') {
    const user = await this.getByTelegramId(telegramId);
    if (!user) throw new Error('User not found.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { credits: { increment: amount } } });
      await tx.creditLedger.create({
        data: {
          userId: user.id,
          type: 'ADMIN_ADJUSTMENT',
          delta: amount,
          balance: updated.credits,
          note,
        },
      });
      return updated;
    });
  }

  async normalizePremium(user: User): Promise<User> {
    if (user.role !== UserRole.PREMIUM || !user.premiumUntil) return user;
    if (user.premiumUntil.getTime() > Date.now()) return user;
    return this.prisma.user.update({
      where: { id: user.id },
      data: { role: UserRole.FREE, premiumUntil: null, premiumPaidDailyCap: null },
    });
  }
}
