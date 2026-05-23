import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { retailerAccounts } from '@/db/schema/index.js';
import { notify } from '@/shared/notify.js';

type NotificationKind =
  | 'order'
  | 'refund'
  | 'payout'
  | 'kyc'
  | 'system'
  | 'issue'
  | 'compliance'
  | 'promotion';

export interface NotifyStoreAccountsParams {
  storeId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Fan out one inbox notification to every retailer account attached to a store
 * (owner + managers + staff). Returns the number of recipients written.
 */
export async function notifyStoreAccounts(p: NotifyStoreAccountsParams): Promise<number> {
  const accounts = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, p.storeId),
  });
  await Promise.all(
    accounts.map((a) =>
      notify({
        recipientKind: 'retailer',
        recipientId: a.id,
        kind: p.kind,
        title: p.title,
        body: p.body ?? null,
        deepLink: p.deepLink ?? null,
        payload: p.payload ?? null,
      }),
    ),
  );
  return accounts.length;
}
