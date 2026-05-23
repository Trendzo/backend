/**
 * Admin platform configuration: delegation modes.
 */
import { eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { platformConfig } from '@/db/schema/index.js';
import { DELEGATION_MODE_DEFAULTS } from '@/db/seed/delegation-modes.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { ModeBody } from './platform.validators.js';

export async function getDelegationModes() {
  const rows = await db.query.platformConfig.findMany({
    where: inArray(
      platformConfig.key,
      Object.keys(DELEGATION_MODE_DEFAULTS).map((k) => `delegation_mode__${k}`),
    ),
  });
  const overrides = Object.fromEntries(rows.map((r) => [r.key, r.value as string]));
  const result = Object.entries(DELEGATION_MODE_DEFAULTS).map(([capability, defaultMode]) => ({
    capability,
    mode: overrides[`delegation_mode__${capability}`] ?? defaultMode,
    isDefault: !overrides[`delegation_mode__${capability}`],
  }));
  return ok(result);
}

export async function setDelegationMode(input: {
  capability: string;
  body: z.infer<typeof ModeBody>;
}) {
  const { capability } = input;
  if (!(capability in DELEGATION_MODE_DEFAULTS)) {
    throw new AppError(404, ErrorCode.NotFound, `Unknown capability: ${capability}`);
  }
  const key = `delegation_mode__${capability}`;
  const existing = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, key),
  });
  if (existing) {
    await db
      .update(platformConfig)
      .set({ value: input.body.mode, priorValue: existing.value, lastChangedAt: new Date() })
      .where(eq(platformConfig.key, key));
  } else {
    await db
      .insert(platformConfig)
      .values({ key, value: input.body.mode, description: `Delegation mode for ${capability}` });
  }
  return ok({ capability, mode: input.body.mode });
}
