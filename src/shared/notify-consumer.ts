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

export interface NotifyConsumerParams {
  consumerId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * One inbox notification to a consumer recipient. Mirrors notify-store.ts.
 */
export async function notifyConsumer(p: NotifyConsumerParams): Promise<void> {
  await notify({
    recipientKind: 'consumer',
    recipientId: p.consumerId,
    kind: p.kind,
    title: p.title,
    body: p.body ?? null,
    deepLink: p.deepLink ?? null,
    payload: p.payload ?? null,
  });
}
