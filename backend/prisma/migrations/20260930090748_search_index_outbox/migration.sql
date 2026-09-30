-- CreateEnum
CREATE TYPE "search_index_state" AS ENUM ('pending', 'indexed');

-- CreateTable
CREATE TABLE "search_index_outbox" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "state" "search_index_state" NOT NULL DEFAULT 'pending',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "search_index_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "search_index_outbox_delivery_id_key" ON "search_index_outbox"("delivery_id");

-- CreateIndex
CREATE INDEX "search_index_outbox_state_created_idx" ON "search_index_outbox"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "search_index_outbox_delivery_user_key" ON "search_index_outbox"("delivery_id", "user_id");

-- AddForeignKey
ALTER TABLE "search_index_outbox" ADD CONSTRAINT "search_index_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_index_outbox" ADD CONSTRAINT "search_index_outbox_delivery_user_fkey" FOREIGN KEY ("delivery_id", "user_id") REFERENCES "email_deliveries"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
