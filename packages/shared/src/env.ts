import { z } from "zod";

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), {
    message: "DATABASE_URL must use the postgresql:// or postgres:// scheme",
  }),
  REDIS_URL: z.string().url().refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
    message: "REDIS_URL must use the redis:// or rediss:// scheme",
  }),
  ELASTICSEARCH_URL: z.string().url(),
  ELASTICSEARCH_API_KEY: z.string().min(1).optional(),
  FRONTEND_ORIGIN: z.string().url()
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.origin === value && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }, "FRONTEND_ORIGIN must be an origin without a path or credentials")
    .default("http://localhost:5173"),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_OAUTH_STATE_SECRET: z.string().min(32).optional(),
  SLACK_CLIENT_ID: z.string().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_REDIRECT_URI: z.string().url().optional(),
  SLACK_OAUTH_STATE_SECRET: z.string().min(32).optional(),
  SLACK_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("mailflow_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(168),
  MIN_DELAY_MS: z.coerce.number().int().min(0).max(86_400_000).default(2_000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).max(100_000).default(200),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().min(1).max(100_000).default(10_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  ETHEREAL_HOST: z.string().min(1).optional(),
  ETHEREAL_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  ETHEREAL_USER: z.string().min(1).optional(),
  ETHEREAL_PASSWORD: z.string().min(1).optional(),
  ETHEREAL_FROM: z.string().min(1).optional(),
}).superRefine((value, context) => {
  const googleValues = [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_REDIRECT_URI];
  const configuredCount = googleValues.filter(Boolean).length;
  if (configuredCount !== 0 && configuredCount !== googleValues.length) {
    context.addIssue({
      code: "custom",
      path: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
      message: "Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI together",
    });
  }
  if (configuredCount === googleValues.length && !value.GOOGLE_OAUTH_STATE_SECRET) {
    context.addIssue({
      code: "custom",
      path: ["GOOGLE_OAUTH_STATE_SECRET"],
      message: "GOOGLE_OAUTH_STATE_SECRET (at least 32 characters) is required when Google OAuth is configured",
    });
  }
  const slackValues = [value.SLACK_CLIENT_ID, value.SLACK_CLIENT_SECRET, value.SLACK_REDIRECT_URI];
  const slackCount = slackValues.filter(Boolean).length;
  if (slackCount !== 0 && slackCount !== slackValues.length) {
    context.addIssue({
      code: "custom",
      path: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_REDIRECT_URI"],
      message: "Slack OAuth requires SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI together",
    });
  }
  if (slackCount === slackValues.length) {
    if (!value.SLACK_OAUTH_STATE_SECRET) context.addIssue({ code: "custom", path: ["SLACK_OAUTH_STATE_SECRET"], message: "SLACK_OAUTH_STATE_SECRET (at least 32 characters) is required when Slack OAuth is configured" });
    if (!value.SLACK_TOKEN_ENCRYPTION_KEY) context.addIssue({ code: "custom", path: ["SLACK_TOKEN_ENCRYPTION_KEY"], message: "SLACK_TOKEN_ENCRYPTION_KEY is required when Slack OAuth is configured" });
  }
  if (value.SLACK_TOKEN_ENCRYPTION_KEY) {
    const decoded = Buffer.from(value.SLACK_TOKEN_ENCRYPTION_KEY, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== value.SLACK_TOKEN_ENCRYPTION_KEY) {
      context.addIssue({ code: "custom", path: ["SLACK_TOKEN_ENCRYPTION_KEY"], message: "SLACK_TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key" });
    }
  }
  const etherealValues = [value.ETHEREAL_HOST, value.ETHEREAL_PORT, value.ETHEREAL_USER, value.ETHEREAL_PASSWORD];
  const etherealCount = etherealValues.filter((item) => item !== undefined).length;
  if (etherealCount !== 0 && etherealCount !== etherealValues.length) {
    context.addIssue({
      code: "custom",
      path: ["ETHEREAL_HOST", "ETHEREAL_PORT", "ETHEREAL_USER", "ETHEREAL_PASSWORD"],
      message: "Ethereal SMTP requires ETHEREAL_HOST, ETHEREAL_PORT, ETHEREAL_USER, and ETHEREAL_PASSWORD together",
    });
  }
  if (value.ETHEREAL_FROM && etherealCount !== etherealValues.length) {
    context.addIssue({ code: "custom", path: ["ETHEREAL_FROM"], message: "ETHEREAL_FROM requires a complete Ethereal SMTP configuration" });
  }
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function loadServerEnvironment(source: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  const result = serverEnvironmentSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `- ${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid MailFlow server configuration:\n${details}`);
  }

  return result.data;
}
