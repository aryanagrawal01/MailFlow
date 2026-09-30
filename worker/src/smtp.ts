import nodemailer from "nodemailer";
import type { ServerEnvironment } from "@mailflow/shared";
import type { EmailTransport } from "./delivery-processor.js";

export function createEtherealTransport(environment: ServerEnvironment): { transport: EmailTransport; from: string } {
  const { ETHEREAL_HOST: host, ETHEREAL_PORT: port, ETHEREAL_USER: user, ETHEREAL_PASSWORD: pass } = environment;
  if (!host || !port || !user || !pass) {
    throw new Error("Ethereal is not configured. Set ETHEREAL_HOST, ETHEREAL_PORT, ETHEREAL_USER, and ETHEREAL_PASSWORD in the root .env file.");
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    logger: false,
    debug: false,
  });
  return { transport, from: environment.ETHEREAL_FROM ?? user };
}
