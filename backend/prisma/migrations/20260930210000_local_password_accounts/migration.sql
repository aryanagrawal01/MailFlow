ALTER TABLE "users" ALTER COLUMN "google_subject" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "username" VARCHAR(32);
ALTER TABLE "users" ADD COLUMN "password_hash" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "contact_number" VARCHAR(32);
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_local_email_lower_key" ON "users"(lower("email")) WHERE "google_subject" IS NULL;
