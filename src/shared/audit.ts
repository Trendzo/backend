import { db } from '@/db/client.js';
import { auditLog } from '@/db/schema/index.js';
import { newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

export interface AuditParams {
  actor: Pick<AccessTokenPayload, 'kind' | 'sub'>;
  action: string;
  resourceKind: string;
  resourceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  impersonatedStoreId?: string | null;
  note?: string | null;
  requestId?: string | null;
}

export async function recordAudit(params: AuditParams): Promise<void> {
  await db.insert(auditLog).values({
    id: newId('aud'),
    actorKind: params.actor.kind as 'admin' | 'retailer' | 'consumer' | 'delivery_agent' | 'system',
    actorId: params.actor.sub ?? null,
    action: params.action,
    resourceKind: params.resourceKind,
    resourceId: params.resourceId ?? null,
    before: params.before ?? null,
    after: params.after ?? null,
    impersonatedStoreId: params.impersonatedStoreId ?? null,
    note: params.note ?? null,
    requestId: params.requestId ?? null,
  });
}
