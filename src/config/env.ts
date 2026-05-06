import 'dotenv/config';
import { z } from 'zod';

/**
 * Validates env vars at startup. The app crashes immediately if anything is missing or malformed
 * — this is intentional and matches the api-validation skill's "parse, don't validate" stance.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  TCS_RATE_BP: z.coerce.number().int().nonnegative().default(100),

  // Cloudinary — single media-upload provider for the platform. Optional at boot
  // so dev environments without media work, but `POST /uploads` will 503 until set.
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),

  // Seed defaults — only consumed by the seed CLI (`npm run db:seed`).
  ADMIN_SEED_EMAIL: z.string().email().default('admin@closetx.local'),
  ADMIN_SEED_PASSWORD: z.string().min(4).default('admin1234'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
