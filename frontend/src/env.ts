import { z } from "zod";

const frontendEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.string().url().default("http://localhost:4000"),
  VITE_FIREBASE_API_KEY: z.string().min(1).optional(),
  VITE_FIREBASE_AUTH_DOMAIN: z.string().min(1).optional(),
  VITE_FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  VITE_FIREBASE_APP_ID: z.string().min(1).optional(),
});

const result = frontendEnvironmentSchema.safeParse(import.meta.env);
if (!result.success) {
  throw new Error(`Invalid frontend configuration: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
}

export const frontendEnvironment = result.data;
