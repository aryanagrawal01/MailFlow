import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generation and schema validation do not connect to PostgreSQL. Migration
  // scripts load the real URL from the root .env before invoking Prisma.
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://mailflow:mailflow_local_only@127.0.0.1:5432/mailflow",
  },
});
