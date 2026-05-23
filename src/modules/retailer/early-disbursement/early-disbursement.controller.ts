import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { earlyDisbursementRequests, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { CreateRequestBody } from './early-disbursement.validators.js';

type Auth = AccessTokenPayload;

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

function shapeRequest(
  r: typeof earlyDisbursementRequests.$inferSelect,
  storeName?: string,
) {
  return {
    id: r.id,
    storeId: r.storeId,
    storeName: storeName ?? r.storeId,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
  };
}

export async function listRequests(input: { auth: Auth }) {
  const storeId = await getStoreId(input.auth.sub);

  const rows = await db.query.earlyDisbursementRequests.findMany({
    where: eq(earlyDisbursementRequests.storeId, storeId),
    orderBy: desc(earlyDisbursementRequests.requestedAt),
    with: { store: true },
  });

  return ok(rows.map((r) => shapeRequest(r, r.store?.legalName)));
}

export async function createRequest(input: {
  auth: Auth;
  body: z.infer<typeof CreateRequestBody>;
}) {
  const { auth, body } = input;
  const storeId = await getStoreId(auth.sub);

  const existing = await db.query.earlyDisbursementRequests.findFirst({
    where: and(
      eq(earlyDisbursementRequests.storeId, storeId),
      eq(earlyDisbursementRequests.status, 'pending'),
    ),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'A pending early disbursement request already exists',
    );
  }

  const id = newId('edr');
  await db.insert(earlyDisbursementRequests).values({
    id,
    storeId,
    amountPaise: body.amountPaise,
    reason: body.reason,
  });

  return ok({ id, status: 'pending' });
}
