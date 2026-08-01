/**
 * The single place a return's goods are recorded as physically present at the store.
 *
 * Custody (`goodsReceivedAt`) and the decision deadline (`verificationWindowExpiresAt`)
 * are always stamped together — that pairing is the invariant the
 * `returns_window_requires_custody_guard` CHECK enforces. Four call sites used to
 * hand-roll "read the config, then UPDATE … WHERE window IS NULL", each with its own
 * copy of the fallback, and none of them recorded custody at all.
 *
 * Arming is what lets the existing machinery run: once the window is set, the
 * verification sweep will auto-accept and refund at expiry. It must therefore ONLY
 * happen when a human (or a driver's scan) has actually asserted the goods arrived —
 * never on a timer, and never for goods still in transit.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { platformConfig, returns } from '@/db/schema/index.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type DbOrTx = typeof Db | Tx;

const DEFAULT_VERIFICATION_WINDOW_HOURS = 24;

export async function verificationWindowHours(dbx: DbOrTx): Promise<number> {
  const cfg = await dbx.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'verification_window_hours'),
  });
  return cfg && typeof cfg.value === 'number' ? cfg.value : DEFAULT_VERIFICATION_WINDOW_HOURS;
}

/** The pair every arming site writes. Never set one without the other. */
export async function goodsReceivedStamp(
  dbx: DbOrTx,
  now = new Date(),
): Promise<{ goodsReceivedAt: Date; verificationWindowExpiresAt: Date }> {
  const hours = await verificationWindowHours(dbx);
  return {
    goodsReceivedAt: now,
    verificationWindowExpiresAt: new Date(now.getTime() + hours * 3_600_000),
  };
}

/**
 * Stamp custody + deadline on one return. Guarded to still-pending, not-yet-received
 * rows, so a return decided at the counter meanwhile is a clean no-op.
 */
export async function markReturnGoodsReceived(
  dbx: DbOrTx,
  returnId: string,
): Promise<{ stamped: boolean; verificationWindowExpiresAt: Date }> {
  const stamp = await goodsReceivedStamp(dbx);
  const [row] = await dbx
    .update(returns)
    .set(stamp)
    .where(
      and(
        eq(returns.id, returnId),
        eq(returns.storeDecision, 'pending'),
        isNull(returns.goodsReceivedAt),
      ),
    )
    .returning({ id: returns.id });
  return { stamped: Boolean(row), verificationWindowExpiresAt: stamp.verificationWindowExpiresAt };
}

/** Same, for the batch of returns a single reverse-pickup task carried. */
export async function markReturnsGoodsReceived(
  dbx: DbOrTx,
  returnIds: string[],
): Promise<{ stampedIds: string[]; verificationWindowExpiresAt: Date }> {
  const stamp = await goodsReceivedStamp(dbx);
  if (returnIds.length === 0) {
    return { stampedIds: [], verificationWindowExpiresAt: stamp.verificationWindowExpiresAt };
  }
  const rows = await dbx
    .update(returns)
    .set(stamp)
    .where(
      and(
        inArray(returns.id, returnIds),
        eq(returns.storeDecision, 'pending'),
        isNull(returns.goodsReceivedAt),
      ),
    )
    .returning({ id: returns.id });
  return {
    stampedIds: rows.map((r) => r.id),
    verificationWindowExpiresAt: stamp.verificationWindowExpiresAt,
  };
}

/**
 * Every still-pending return on an order — used by `arriveOrderAtStore`, where the
 * parcel physically reaching the store IS the custody assertion for the door returns
 * it carries. Stamping before auto-accept means that if auto-accept throws, the
 * verification sweep still picks the return up at window expiry instead of it being
 * stranded forever.
 */
export async function markOrderReturnsGoodsReceived(
  dbx: DbOrTx,
  orderId: string,
): Promise<string[]> {
  const pending = await dbx.query.returns.findMany({
    where: eq(returns.storeDecision, 'pending'),
    columns: { id: true },
    with: { orderItem: { columns: { orderId: true } } },
  });
  const ids = pending.filter((r) => r.orderItem.orderId === orderId).map((r) => r.id);
  const { stampedIds } = await markReturnsGoodsReceived(dbx, ids);
  return stampedIds;
}
