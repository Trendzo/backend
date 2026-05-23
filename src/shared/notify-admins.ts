/**
 * §22 fan-out a notification to every active admin account. Used when an event
 * needs the entire admin team to see it (new dispute, failed payout, retailer
 * application, consumer flag, escalation).
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { adminAccounts } from '@/db/schema/index.js';
import { notify, type NotifyParams } from './notify.js';

export interface NotifyAdminsParams {
  kind: NotifyParams['kind'];
  title: string;
  body?: string | null;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function notifyAllAdmins(p: NotifyAdminsParams): Promise<void> {
  const admins = await db
    .select({ id: adminAccounts.id })
    .from(adminAccounts)
    .where(eq(adminAccounts.status, 'active'));
  await Promise.all(
    admins.map((a) =>
      notify({
        recipientKind: 'admin',
        recipientId: a.id,
        kind: p.kind,
        title: p.title,
        body: p.body ?? null,
        deepLink: p.deepLink ?? null,
        payload: p.payload ?? null,
      }),
    ),
  );
}
