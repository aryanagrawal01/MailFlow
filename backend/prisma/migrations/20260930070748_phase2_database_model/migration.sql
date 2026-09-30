-- CreateEnum
CREATE TYPE "email_delivery_status" AS ENUM ('scheduled', 'processing', 'sent', 'failed', 'delivery_unknown');

-- CreateEnum
CREATE TYPE "delivery_attempt_outcome" AS ENUM ('in_progress', 'sent', 'retryable_failure', 'permanent_failure', 'delivery_unknown');

-- CreateEnum
CREATE TYPE "queue_outbox_state" AS ENUM ('pending', 'enqueued');

-- CreateEnum
CREATE TYPE "slack_alert_status" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "google_subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" VARCHAR(998) NOT NULL,
    "body" TEXT NOT NULL,
    "requested_start_at" TIMESTAMPTZ(3) NOT NULL,
    "delay_ms" INTEGER NOT NULL,
    "hourly_limit" INTEGER NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "recipient_email" VARCHAR(320) NOT NULL,
    "normalized_recipient" VARCHAR(320) NOT NULL,
    "recipient_position" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "email_delivery_status" NOT NULL DEFAULT 'scheduled',
    "sent_at" TIMESTAMPTZ(3),
    "send_started_at" TIMESTAMPTZ(3),
    "smtp_message_id" VARCHAR(998),
    "failure_code" VARCHAR(100),
    "failure_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "outcome" "delivery_attempt_outcome" NOT NULL DEFAULT 'in_progress',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "smtp_started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "smtp_message_id" VARCHAR(998),
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_outbox" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "job_id" VARCHAR(128) NOT NULL,
    "state" "queue_outbox_state" NOT NULL DEFAULT 'pending',
    "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
    "enqueued_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "queue_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slack_team_id" VARCHAR(64) NOT NULL,
    "slack_team_name" VARCHAR(255),
    "slack_user_id" VARCHAR(64),
    "bot_token_encrypted" TEXT NOT NULL,
    "channel_id" VARCHAR(64) NOT NULL,
    "channel_name" VARCHAR(255),
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_alerts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "hour_window_start" TIMESTAMPTZ(3) NOT NULL,
    "status" "slack_alert_status" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(3),
    "slack_message_ts" VARCHAR(32),
    "error_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slack_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_expires_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "campaigns_user_created_idx" ON "campaigns"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_id_user_id_key" ON "campaigns"("id", "user_id");

-- CreateIndex
CREATE INDEX "email_deliveries_user_status_scheduled_idx" ON "email_deliveries"("user_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "email_deliveries_user_sent_idx" ON "email_deliveries"("user_id", "sent_at");

-- CreateIndex
CREATE INDEX "email_deliveries_campaign_status_idx" ON "email_deliveries"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "email_deliveries_user_recipient_idx" ON "email_deliveries"("user_id", "recipient_email");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_campaign_recipient_key" ON "email_deliveries"("campaign_id", "normalized_recipient");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_campaign_position_key" ON "email_deliveries"("campaign_id", "recipient_position");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_id_user_id_key" ON "email_deliveries"("id", "user_id");

-- CreateIndex
CREATE INDEX "delivery_attempts_user_started_idx" ON "delivery_attempts"("user_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_number_key" ON "delivery_attempts"("delivery_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "queue_outbox_delivery_id_key" ON "queue_outbox"("delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_outbox_job_id_key" ON "queue_outbox"("job_id");

-- CreateIndex
CREATE INDEX "queue_outbox_user_state_created_idx" ON "queue_outbox"("user_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "slack_connections_user_id_key" ON "slack_connections"("user_id");

-- CreateIndex
CREATE INDEX "slack_connections_team_idx" ON "slack_connections"("slack_team_id");

-- CreateIndex
CREATE INDEX "slack_alerts_status_created_idx" ON "slack_alerts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "slack_alerts_user_hour_key" ON "slack_alerts"("user_id", "hour_window_start");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_campaign_user_fkey" FOREIGN KEY ("campaign_id", "user_id") REFERENCES "campaigns"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_user_fkey" FOREIGN KEY ("delivery_id", "user_id") REFERENCES "email_deliveries"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_delivery_user_fkey" FOREIGN KEY ("delivery_id", "user_id") REFERENCES "email_deliveries"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_campaign_user_fkey" FOREIGN KEY ("campaign_id", "user_id") REFERENCES "campaigns"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_alerts" ADD CONSTRAINT "slack_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
