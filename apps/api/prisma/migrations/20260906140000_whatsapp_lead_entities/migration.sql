-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'HOT', 'NURTURE', 'DISQUALIFIED', 'CONVERTED');

-- NOTE: Prisma emits a false-drift `DROP INDEX "KnowledgeChunk_embedding_idx";`
-- here because it cannot model the pgvector HNSW index on the Unsupported
-- vector column. That line was removed by hand so the knowledge index survives
-- (see platform/CLAUDE.md pgvector gotcha).

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT,
    "twilioAccountSid" TEXT NOT NULL,
    "twilioAuthToken" TEXT NOT NULL,
    "whatsappSenderNumber" TEXT NOT NULL,
    "status" "SkillConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" "LeadSource" NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "qualificationData" JSONB,
    "conversationId" TEXT,
    "assignedToUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastContactedAt" TIMESTAMP(3),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppAccount_companyId_idx" ON "WhatsAppAccount"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_companyId_whatsappSenderNumber_key" ON "WhatsAppAccount"("companyId", "whatsappSenderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_conversationId_key" ON "Lead"("conversationId");

-- CreateIndex
CREATE INDEX "Lead_companyId_status_idx" ON "Lead"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_companyId_source_phone_key" ON "Lead"("companyId", "source", "phone");

-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AiEmployee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
