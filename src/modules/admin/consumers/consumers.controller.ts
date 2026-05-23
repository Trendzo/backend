/**
 * Admin consumer management + test consumer minting.
 */
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  addresses,
  consumerFlags,
  consumers,
  giftCards,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { hashPassword } from '@/shared/auth/password.js';
import { banConsumerFromSurface, liftBan, listBans } from '@/shared/consumers/ban-surface.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { closeConsumerWithRetention } from '@/shared/consumers/close-consumer.js';
import { buildConsumerProfile } from '@/shared/consumers/consumer-profile.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CloseBody,
  CreateBanBody,
  CreateConsumerBody,
  CreateFlagBody,
  FlagsQuery,
  LiftBanBody,
  ListBansQuery,
  ListQuery,
  MintTestBody,
  ResolveFlagBody,
  SuspendBody,
  UnsuspendBody,
} from './consumers.validators.js';

type Auth = AccessTokenPayload;

function safeConsumer(c: typeof consumers.$inferSelect) {
  const { passwordHash: _ph, ...rest } = c;
  return rest;
}

export async function listConsumers(input: { query: z.infer<typeof ListQuery> }) {
  const { q, status, limit, offset } = input.query;
  const filters = [];
  if (q) {
    const needle = `%${q}%`;
    filters.push(
      or(
        ilike(consumers.name, needle),
        ilike(consumers.email, needle),
        ilike(consumers.phone, needle),
      )!,
    );
  }
  if (status) filters.push(eq(consumers.status, status));
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

  const rows = await db.query.consumers.findMany({
    ...(where && { where }),
    orderBy: desc(consumers.signupAt),
    limit,
    offset,
  });
  return ok(rows.map(safeConsumer));
}

export async function getConsumer(input: { id: string }) {
  const consumer = await db.query.consumers.findFirst({ where: eq(consumers.id, input.id) });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  return ok(safeConsumer(consumer));
}

export async function getConsumerProfile(input: { id: string }) {
  const profile = await buildConsumerProfile(input.id);
  if (!profile) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  return ok(profile);
}

export async function getConsumerAddresses(input: { id: string }) {
  const consumer = await db.query.consumers.findFirst({ where: eq(consumers.id, input.id) });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  const rows = await db.query.addresses.findMany({
    where: eq(addresses.consumerId, input.id),
    orderBy: desc(addresses.isDefault),
  });
  return ok(rows);
}

export async function suspendConsumer(input: {
  id: string;
  body: z.infer<typeof SuspendBody>;
  log: FastifyBaseLogger;
}) {
  const consumer = await db.query.consumers.findFirst({ where: eq(consumers.id, input.id) });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  if (consumer.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot suspend consumer in '${consumer.status}' status`,
    );
  }
  const [updated] = await db
    .update(consumers)
    .set({ status: 'suspended' })
    .where(eq(consumers.id, consumer.id))
    .returning();
  input.log.info({ consumerId: consumer.id, reason: input.body.reason }, 'consumer suspended');
  return ok(safeConsumer(updated!));
}

export async function unsuspendConsumer(input: {
  id: string;
  body: z.infer<typeof UnsuspendBody>;
  log: FastifyBaseLogger;
}) {
  const consumer = await db.query.consumers.findFirst({ where: eq(consumers.id, input.id) });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  if (consumer.status !== 'suspended') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Consumer is not suspended (current status: '${consumer.status}')`,
    );
  }
  const [updated] = await db
    .update(consumers)
    .set({ status: 'active' })
    .where(eq(consumers.id, consumer.id))
    .returning();
  const body = input.body as { reason?: string } | undefined;
  input.log.info({ consumerId: consumer.id, reason: body?.reason }, 'consumer unsuspended');
  return ok(safeConsumer(updated!));
}

export async function closeConsumer(input: {
  id: string;
  body: z.infer<typeof CloseBody>;
  log: FastifyBaseLogger;
  auth: Auth;
}) {
  const result = await closeConsumerWithRetention({
    consumerId: input.id,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  input.log.info(
    { consumerId: input.id, reason: input.body.reason, deletionRequestId: result.deletionRequestId },
    'consumer account closed',
  );
  return ok(result);
}

export async function getConsumerGiftCards(input: { id: string }) {
  const cards = await db.query.giftCards.findMany({
    where: eq(giftCards.consumerId, input.id),
    orderBy: desc(giftCards.createdAt),
  });
  const totalPaise = cards.reduce((sum, c) => sum + c.balancePaise, 0);
  return ok({
    totalPaise,
    cards: cards.map((c) => ({
      id: c.id,
      code: c.code,
      balancePaise: c.balancePaise,
      expiresOn: c.expiresOn,
    })),
  });
}

export async function listFlags(input: { id: string; query: z.infer<typeof FlagsQuery> }) {
  const conds = [eq(consumerFlags.consumerId, input.id)];
  if (!input.query.includeResolved) conds.push(isNull(consumerFlags.resolvedAt));
  const rows = await db
    .select()
    .from(consumerFlags)
    .where(and(...conds))
    .orderBy(desc(consumerFlags.createdAt));
  return ok(rows);
}

export async function createFlag(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof CreateFlagBody>;
  requestId: string;
}) {
  const c = await db.query.consumers.findFirst({ where: eq(consumers.id, input.id) });
  if (!c) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');

  const id = newId(IdPrefix.ConsumerFlag);
  const [created] = await db
    .insert(consumerFlags)
    .values({
      id,
      consumerId: input.id,
      kind: input.body.kind,
      reason: input.body.reason,
      createdByAdminId: input.auth.sub,
    })
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'consumer.flag',
    resourceKind: 'consumer',
    resourceId: input.id,
    after: { flagId: id, kind: input.body.kind, reason: input.body.reason },
    note: input.body.reason,
    requestId: input.requestId,
  });
  await notifyAllAdmins({
    kind: 'compliance',
    title: 'Consumer flag raised',
    body: `${input.body.kind}: ${input.body.reason}`,
    deepLink: `/admin/consumers/${input.id}`,
    payload: { consumerId: input.id, flagId: id, kind: input.body.kind },
  });
  return ok(created);
}

export async function resolveFlag(input: {
  auth: Auth;
  id: string;
  flagId: string;
  body: z.infer<typeof ResolveFlagBody>;
  requestId: string;
}) {
  const flag = await db.query.consumerFlags.findFirst({
    where: and(eq(consumerFlags.id, input.flagId), eq(consumerFlags.consumerId, input.id)),
  });
  if (!flag) throw new AppError(404, ErrorCode.NotFound, 'Flag not found');
  if (flag.resolvedAt) {
    throw new AppError(409, ErrorCode.InvalidState, 'Flag already resolved');
  }
  const note = input.body?.note ?? null;
  const [updated] = await db
    .update(consumerFlags)
    .set({
      resolvedAt: new Date(),
      resolvedByAdminId: input.auth.sub,
      resolvedNote: note,
    })
    .where(eq(consumerFlags.id, input.flagId))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'consumer.flag_resolved',
    resourceKind: 'consumer',
    resourceId: input.id,
    after: { flagId: input.flagId },
    note,
    requestId: input.requestId,
  });
  return ok(updated);
}

export async function createBan(input: {
  id: string;
  body: z.infer<typeof CreateBanBody>;
  auth: Auth;
}) {
  const ban = await banConsumerFromSurface({
    consumerId: input.id,
    surface: input.body.surface,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  return ok(ban);
}

export async function liftBanCtrl(input: {
  id: string;
  banId: string;
  body: z.infer<typeof LiftBanBody>;
  auth: Auth;
}) {
  const ban = await liftBan({
    banId: input.banId,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  return ok(ban);
}

export async function listConsumerBans(input: { id: string; query: z.infer<typeof ListBansQuery> }) {
  const bans = await listBans({ consumerId: input.id, includeLifted: !!input.query.includeLifted });
  return ok(bans);
}

export async function createConsumer(input: {
  body: z.infer<typeof CreateConsumerBody>;
  auth: Auth;
  requestId: string;
}) {
  const { body } = input;
  // Duplicate email/phone check.
  const clashEmail = await db.query.consumers.findFirst({
    where: eq(consumers.email, body.email),
    columns: { id: true },
  });
  if (clashEmail) {
    throw new AppError(409, ErrorCode.EmailAlreadyTaken, 'Email already in use');
  }
  const clashPhone = await db.query.consumers.findFirst({
    where: eq(consumers.phone, body.phone),
    columns: { id: true },
  });
  if (clashPhone) {
    throw new AppError(409, ErrorCode.InvalidState, 'Phone already in use');
  }
  const id = newId(IdPrefix.Consumer);
  const passwordHash = await hashPassword(body.password ?? 'ChangeMe!1');
  await db.insert(consumers).values({
    id,
    email: body.email,
    phone: body.phone,
    name: body.name,
    passwordHash,
    genderPreference: body.genderPreference ?? null,
  });
  await recordAudit({
    actor: input.auth,
    action: 'consumer.create',
    resourceKind: 'consumer',
    resourceId: id,
    after: { email: body.email, phone: body.phone, name: body.name },
    requestId: input.requestId,
  });
  return ok({ id, email: body.email, phone: body.phone, name: body.name });
}

export async function mintTestConsumer(input: { body: z.infer<typeof MintTestBody> }) {
  const body = input.body as { legalName?: string; storeId?: string };
  const slug = newId(IdPrefix.Consumer).slice(4, 12);
  const name = body.legalName?.trim() || `Test Consumer ${slug}`;
  const email = `test-${slug}@closetx.test`;
  const phone = `+91${Math.floor(7000000000 + Math.random() * 999999999)}`;
  const passwordHash = await hashPassword('TestPass!1');

  let stateCode = '27';
  let lat = 19.076;
  let lng = 72.8777;
  const city = 'Mumbai';
  const pincode = '400001';
  if (body.storeId) {
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, body.storeId),
    });
    if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
    stateCode = store.stateCode;
    lat = store.lat;
    lng = store.lng;
  }

  const consumerId = newId(IdPrefix.Consumer);
  await db.insert(consumers).values({
    id: consumerId,
    email,
    phone,
    name,
    passwordHash,
  });

  const addressId = newId(IdPrefix.Address);
  await db.insert(addresses).values({
    id: addressId,
    consumerId,
    label: 'home',
    line1: 'Test Address Line 1',
    line2: null,
    city,
    pincode,
    stateCode,
    lat,
    lng,
    isDefault: true,
  });

  return ok({
    consumer: { id: consumerId, email, phone, name },
    addressId,
  });
}
