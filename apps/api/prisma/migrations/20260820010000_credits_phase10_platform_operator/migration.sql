-- Credit system Phase 10, Task 10.1: PlatformOperator (structurally distinct
-- identity, no relation to Company/User).
CREATE TABLE "PlatformOperator" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformOperator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformOperator_email_key" ON "PlatformOperator"("email");
