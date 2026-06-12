/**
 * Find-or-create a consumer's wallet row inside a transaction, returning its id.
 * Wallets are meant to exist eagerly (created at signup with a zero balance), but
 * the lazy fallback keeps callers safe for any consumer minted before that landed.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { consumerWallets } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function ensureWallet(tx: Tx, consumerId: string): Promise<string> {
  const existing = await tx.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, consumerId),
  });
  if (existing) return existing.id;

  // Race-tolerant create: a concurrent first-ever wallet op for the same consumer would
  // otherwise abort the whole transaction on the consumer_wallets_consumer_idx unique
  // violation. onConflictDoNothing swallows that; on a lost race `returning` is empty, so we
  // re-read the row the winner inserted and hand back its id.
  const id = newId(IdPrefix.WalletTx).replace(/^wtx_/, 'wlt_');
  const [created] = await tx
    .insert(consumerWallets)
    .values({ id, consumerId, balancePaise: 0, version: 0 })
    .onConflictDoNothing({ target: consumerWallets.consumerId })
    .returning();
  if (created) return created.id;

  const won = await tx.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, consumerId),
  });
  return won!.id;
}
