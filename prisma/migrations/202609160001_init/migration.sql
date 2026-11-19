-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('FREE', 'PREMIUM', 'ADMIN');
CREATE TYPE "GenerationType" AS ENUM ('IMAGE', 'IMAGE_EDIT', 'VIDEO', 'ANIMATE', 'LONG_VIDEO');
CREATE TYPE "GenerationMode" AS ENUM ('FREE', 'PREMIUM', 'CINEMA');
CREATE TYPE "GenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');
CREATE TYPE "LedgerType" AS ENUM ('PURCHASE', 'GENERATION', 'REFUND', 'ADMIN_ADJUSTMENT', 'PREMIUM_GRANT');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "telegramId" BIGINT NOT NULL,
  "username" TEXT,
  "firstName" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'FREE',
  "credits" INTEGER NOT NULL DEFAULT 0,
  "premiumUntil" TIMESTAMP(3),
  "premiumPaidDailyCap" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

CREATE TABLE "Generation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "GenerationType" NOT NULL,
  "mode" "GenerationMode" NOT NULL,
  "status" "GenerationStatus" NOT NULL DEFAULT 'QUEUED',
  "prompt" TEXT NOT NULL,
  "negativePrompt" TEXT,
  "durationSec" INTEGER,
  "aspectRatio" TEXT,
  "provider" TEXT,
  "inputPath" TEXT,
  "outputPath" TEXT,
  "outputUrl" TEXT,
  "costCredits" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Generation_userId_createdAt_idx" ON "Generation"("userId", "createdAt");
CREATE INDEX "Generation_status_idx" ON "Generation"("status");
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreditLedger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "LedgerType" NOT NULL,
  "delta" INTEGER NOT NULL,
  "balance" INTEGER NOT NULL,
  "note" TEXT,
  "externalId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditLedger_externalId_key" ON "CreditLedger"("externalId");
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
