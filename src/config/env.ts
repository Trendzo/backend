import 'dotenv/config';
import { z } from 'zod';

/** Optional secret that also treats '' as unset (lets tests blank a .env value). */
const optionalSecret = (min: number) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(min).optional());

/**
 * Validates env vars at startup. The app crashes immediately if anything is missing or malformed
 * — this is intentional and matches the api-validation skill's "parse, don't validate" stance.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Drizzle SQL query logging — kept SEPARATE from LOG_LEVEL so raising the app
    // log level to 'debug' does NOT drag in every SQL statement. Set to 'true'
    // only when you need to inspect raw DB queries.
    DB_QUERY_LOG: z.enum(['true', 'false']).default('false'),

    DATABASE_URL: z.string().url(),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
    // Consumer sessions are long-lived — phone-OTP re-login is high-friction, and there
    // is no refresh-token flow for MVP (matching the admin/retailer stance).
    JWT_CONSUMER_ACCESS_EXPIRES_IN: z.string().default('30d'),
    // Drivers are a standalone identity with the same long-lived, no-refresh stance.
    JWT_DRIVER_ACCESS_EXPIRES_IN: z.string().default('30d'),

    // MSG91 — server-side verification of OTP-widget access tokens. Optional at boot
    // so dev environments without SMS work, but the OTP login endpoints will 503 until
    // set (same pattern as Cloudinary below). Consumer and retailer widgets live under
    // SEPARATE MSG91 accounts, so each has its own account authkey — a token issued by
    // one account only verifies against that account's authkey.
    MSG91_AUTH_KEY: z.string().min(10).optional(), // consumer widget's account
    MSG91_RETAILER_AUTH_KEY: z.string().min(10).optional(), // retailer widget's account
    MSG91_DRIVER_AUTH_KEY: z.string().min(10).optional(), // driver widget's account

    // Firebase service-account JSON (as a string) for sending driver push via FCM. Optional —
    // if unset (and GOOGLE_APPLICATION_CREDENTIALS also unset), push is disabled and drivers
    // fall back to long-poll. This is the SERVER key, not the client google-services.json.
    FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

    // Razorpay — real payment gateway. All three optional at boot: when the key
    // pair is unset the mock gateway runs (client-declared outcomes, simulated
    // refunds) and every test stays network-free. Setting the pair activates the
    // two-phase checkout (server creates a Razorpay Order, the app runs Checkout,
    // the server verifies the signature / consumes the webhook). The webhook
    // secret is separate — set it after registering the webhook in the dashboard;
    // unset = webhook signature verification is skipped (dev only).
    RAZORPAY_KEY_ID: optionalSecret(8),
    RAZORPAY_KEY_SECRET: optionalSecret(8),
    RAZORPAY_WEBHOOK_SECRET: optionalSecret(8),

    // Public legal/support pages used by App Store Connect.
    PUBLIC_APP_NAME: z.string().min(1).default('Trendzo Mockup'),
    PUBLIC_COMPANY_NAME: z.string().min(1).default('Trendzo'),
    PUBLIC_SUPPORT_EMAIL: z.string().email().default('trendzodevelopment@gmail.com'),
    PUBLIC_SUPPORT_PHONE: z.string().optional(),
    PUBLIC_BUSINESS_ADDRESS: z.string().optional(),

    TCS_RATE_BP: z.coerce.number().int().nonnegative().default(100),

    // Cloudinary — single media-upload provider for the platform. Optional at boot
    // so dev environments without media work, but `POST /uploads` will 503 until set.
    CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
    CLOUDINARY_API_KEY: z.string().min(1).optional(),
    CLOUDINARY_API_SECRET: z.string().min(1).optional(),

    // AI image generation provider switch — selects which backend the AI catalog
    // module calls. Both providers ultimately run Gemini's image model; OpenRouter
    // is the no-billing-card alternative path.
    AI_IMAGE_PROVIDER: z.enum(['gemini', 'openrouter', 'vertex']).default('gemini'),

    // Google Gemini API key (AI Studio). Required when AI_IMAGE_PROVIDER=gemini.
    GEMINI_API_KEY: z.string().min(20).optional(),

    // Vertex AI path — same Gemini image model, billed via Google Cloud (used when
    // the AI Studio / OpenRouter free tiers are exhausted). Required when
    // AI_IMAGE_PROVIDER=vertex. Auth via Application Default Credentials: set the
    // standard GOOGLE_APPLICATION_CREDENTIALS to a service-account key JSON with
    // the "Vertex AI User" role on GOOGLE_CLOUD_PROJECT.
    GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
    GOOGLE_CLOUD_LOCATION: z.string().default('us-central1'),

    // OpenRouter API key + model. Required when AI_IMAGE_PROVIDER=openrouter.
    // Model defaults to the Gemini image preview which is the most reliable image-output
    // model on OpenRouter today.
    OPENROUTER_API_KEY: z.string().min(20).optional(),
    OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash-image'),
    OPENROUTER_SITE_URL: z.string().url().optional(),
    OPENROUTER_APP_NAME: z.string().default('ClosetX'),

    // Seed defaults — only consumed by the seed CLI (`npm run db:seed`).
    ADMIN_SEED_EMAIL: z.string().email().default('admin@trendzo.local'),
    ADMIN_SEED_PASSWORD: z.string().min(4).default('admin1234'),

    // CORS allowlist for production. Comma-separated list of origins that may call the API.
    // Leave unset in dev — when NODE_ENV=development, all origins are allowed.
    // Example for prod: CORS_ORIGIN=https://closetx-frontend.vercel.app,https://admin.closetx.in
    CORS_ORIGIN: z.string().optional(),
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
