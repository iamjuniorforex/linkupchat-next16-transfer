-- Phase 19: premium subscriptions, billing records, and business profiles.
-- Additive only. Existing Free accounts keep working with no subscription row.

CREATE TYPE "PlanCode" AS ENUM ('FREE', 'PREMIUM_MONTHLY', 'PREMIUM_YEARLY', 'BUSINESS_MONTHLY');
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');
CREATE TYPE "BillingProvider" AS ENUM ('NONE', 'TEST', 'STRIPE');
CREATE TYPE "CheckoutStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED');
CREATE TYPE "BusinessCategory" AS ENUM ('RETAIL', 'FOOD', 'SERVICES', 'HEALTH', 'EDUCATION', 'OTHER');
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "plan" "PlanCode" NOT NULL DEFAULT 'FREE',
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'INCOMPLETE',
  "provider" "BillingProvider" NOT NULL DEFAULT 'NONE',
  "providerCustomerId" TEXT,
  "providerSubscriptionId" TEXT,
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "scheduledPlan" "PlanCode",
  "canceledAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

CREATE TABLE "CheckoutSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "plan" "PlanCode" NOT NULL,
  "status" "CheckoutStatus" NOT NULL DEFAULT 'PENDING',
  "provider" "BillingProvider" NOT NULL,
  "providerSessionId" TEXT,
  "simulated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CheckoutSession_userId_createdAt_idx" ON "CheckoutSession"("userId", "createdAt");
CREATE INDEX "CheckoutSession_providerSessionId_idx" ON "CheckoutSession"("providerSessionId");

CREATE TABLE "BillingEvent" (
  "id" TEXT NOT NULL,
  "provider" "BillingProvider" NOT NULL,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingEvent_provider_eventId_key" ON "BillingEvent"("provider", "eventId");
CREATE INDEX "BillingEvent_userId_idx" ON "BillingEvent"("userId");

CREATE TABLE "Invoice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "BillingProvider" NOT NULL,
  "providerInvoiceId" TEXT,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "hostedUrl" TEXT,
  "simulated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Invoice_userId_createdAt_idx" ON "Invoice"("userId", "createdAt");

CREATE TABLE "BusinessProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" "BusinessCategory" NOT NULL DEFAULT 'OTHER',
  "phone" TEXT,
  "email" TEXT,
  "website" TEXT,
  "greeting" TEXT,
  "awayMessage" TEXT,
  "awayEnabled" BOOLEAN NOT NULL DEFAULT false,
  "lastAwayAt" TIMESTAMP(3),
  "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "verificationNote" TEXT,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessProfile_userId_key" ON "BusinessProfile"("userId");
CREATE INDEX "BusinessProfile_verificationStatus_idx" ON "BusinessProfile"("verificationStatus");

CREATE TABLE "QuickReply" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuickReply_userId_sortOrder_idx" ON "QuickReply"("userId", "sortOrder");

CREATE TABLE "ConversationTheme" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "themeKey" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationTheme_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationTheme_conversationId_userId_key" ON "ConversationTheme"("conversationId", "userId");
CREATE INDEX "ConversationTheme_userId_idx" ON "ConversationTheme"("userId");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationTheme" ADD CONSTRAINT "ConversationTheme_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationTheme" ADD CONSTRAINT "ConversationTheme_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
