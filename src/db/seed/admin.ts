/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Seed a single super-admin so the dev environment is usable out-of-the-box.
 * Idempotent — only inserts if no admin with the configured email exists.
 *
 * The credentials are read from env vars (ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD) so a
 * production seed can use a strong unique password without touching this file.
 */

import { eq } from 'drizzle-orm';
import { env } from '@/config/env.js';
import type { db as Db } from '@/db/client.js';
import { adminAccounts } from '@/db/schema/index.js';
import { hashPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';

export async function seedAdmin(database: typeof Db): Promise<void> {
  const email = env.ADMIN_SEED_EMAIL;
  const password = env.ADMIN_SEED_PASSWORD;

  const existing = await database.query.adminAccounts.findFirst({
    where: eq(adminAccounts.email, email),
  });
  if (existing) {
    console.log(`  → admin '${email}' already exists, skipping`);
    return;
  }

  const passwordHash = await hashPassword(password);
  await database.insert(adminAccounts).values({
    id: newId(IdPrefix.Admin),
    email,
    passwordHash,
    subRole: 'super_admin',
    status: 'active',
  });
  console.log(`  → seeded super-admin '${email}'`);
}
