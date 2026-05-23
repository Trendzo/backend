import { eq } from 'drizzle-orm';
import { invoiceNumberingRules, invoiceSequenceCounters } from '@/db/schema/index.js';
import type { db as Db } from '@/db/client.js';

export type NumberingRule = {
  prefix: string;
  pattern: string;
  resetCycle: 'never' | 'fiscal_year' | 'monthly';
};

const DEFAULT_RULE: NumberingRule = {
  prefix: 'INV',
  pattern: '{PREFIX}-{YYYY}-{SEQ}',
  resetCycle: 'fiscal_year',
};

export function currentFiscalYear(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-12
  const startYear = month >= 4 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}

export function composeNumber(input: {
  pattern: string;
  prefix: string;
  fiscalYear: string;
  sequenceNo: number;
}): string {
  const seqStr = String(input.sequenceNo).padStart(5, '0');
  return input.pattern
    .replaceAll('{PREFIX}', input.prefix)
    .replaceAll('{YYYY}', input.fiscalYear)
    .replaceAll('{SEQ}', seqStr);
}

export async function resolveNumberingRule(
  tx: TxOrDb,
  legalEntityId: string,
  legalEntityName: string,
): Promise<NumberingRule> {
  const existing = await tx.query.invoiceNumberingRules.findFirst({
    where: eq(invoiceNumberingRules.legalEntityId, legalEntityId),
  });
  if (existing) {
    return {
      prefix: existing.prefix,
      pattern: existing.pattern,
      resetCycle: existing.resetCycle,
    };
  }
  // Auto-seed defaults so super-admin can edit later without manual insert.
  await tx
    .insert(invoiceNumberingRules)
    .values({
      legalEntityId,
      legalEntityName,
      prefix: DEFAULT_RULE.prefix,
      pattern: DEFAULT_RULE.pattern,
      resetCycle: DEFAULT_RULE.resetCycle,
    })
    .onConflictDoNothing();
  return DEFAULT_RULE;
}

type TxOrDb = typeof Db;

/**
 * Reserve the next sequence number for a (legalEntityId, fiscalYear, series) tuple using
 * an UPSERT with `RETURNING last_seq`. Postgres serialises concurrent calls for the same
 * primary key, so this gives gap-free monotonic numbers without needing SELECT FOR UPDATE.
 */
export async function reserveNextSequence(
  tx: TxOrDb,
  args: { legalEntityId: string; fiscalYear: string; series: string },
): Promise<number> {
  // Ensure the row exists. If not, seed at 0. Then atomically bump.
  await tx
    .insert(invoiceSequenceCounters)
    .values({
      legalEntityId: args.legalEntityId,
      fiscalYear: args.fiscalYear,
      series: args.series,
      lastSeq: 0,
    })
    .onConflictDoNothing();

  const updated = await tx
    .update(invoiceSequenceCounters)
    .set({
      lastSeq: incrementLastSeq(),
      updatedAt: new Date(),
    })
    .where(
      andSeq(args.legalEntityId, args.fiscalYear, args.series),
    )
    .returning({ lastSeq: invoiceSequenceCounters.lastSeq });

  if (!updated[0]) {
    throw new Error('Failed to reserve invoice sequence');
  }
  return updated[0].lastSeq;
}

import { and, sql } from 'drizzle-orm';
function andSeq(legalEntityId: string, fiscalYear: string, series: string) {
  return and(
    eq(invoiceSequenceCounters.legalEntityId, legalEntityId),
    eq(invoiceSequenceCounters.fiscalYear, fiscalYear),
    eq(invoiceSequenceCounters.series, series),
  );
}
function incrementLastSeq() {
  return sql`${invoiceSequenceCounters.lastSeq} + 1`;
}
