import pino from "pino";

export function createLogger(service: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "password", "*.password", "smtpPassword", "*.smtpPassword", "etherealPassword", "*.etherealPassword",
        "token", "*.token", "botToken", "*.botToken", "sessionCookie", "*.sessionCookie", "secret", "*.secret",
        "client_secret", "*.client_secret", "clientSecret", "*.clientSecret",
        "GOOGLE_CLIENT_SECRET", "*.GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_STATE_SECRET", "*.GOOGLE_OAUTH_STATE_SECRET",
        "SLACK_CLIENT_SECRET", "*.SLACK_CLIENT_SECRET", "SLACK_OAUTH_STATE_SECRET", "*.SLACK_OAUTH_STATE_SECRET",
        "SLACK_TOKEN_ENCRYPTION_KEY", "*.SLACK_TOKEN_ENCRYPTION_KEY", "ELASTICSEARCH_API_KEY", "*.ELASTICSEARCH_API_KEY",
        "ETHEREAL_PASSWORD", "*.ETHEREAL_PASSWORD", "DATABASE_URL", "*.DATABASE_URL", "REDIS_URL", "*.REDIS_URL",
        "authorization", "*.authorization", "headers.authorization", "req.headers.authorization",
        "cookie", "*.cookie", "set-cookie", "req.headers.cookie",
        "connectionString", "*.connectionString", "databaseUrl", "*.databaseUrl", "redisUrl", "*.redisUrl",
      ],
      censor: "[REDACTED]",
    },
  });
}
