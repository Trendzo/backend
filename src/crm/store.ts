import { randomUUID } from 'node:crypto';
import { crm } from './db/client.js';
import {
  CRM_DEFAULT_TARGETS,
  crmLocalDay,
  deriveCrmStatus,
  type CrmRole,
  type CrmStatus,
  type CrmStepKey,
  type CrmTargets,
} from './domain.js';
import type { CrmRetailer, CrmUser } from './db/types.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

/**
 * Shared CRM data-access helpers: id minting, actor scoping, the audit trail, and the single
 * `recalcStatus` that every mutation funnels through.
 */

export const CrmIdPrefix = {
  User: 'cu',
  Otp: 'cotp',
  Territory: 'ctr',
  Category: 'ccat',
  Retailer: 'clead',
  Assignment: 'casg',
  Visit: 'cvis',
  Checklist: 'cchk',
  Note: 'cnote',
  Followup: 'cfu',
  Document: 'cdoc',
  Target: 'ctgt',
  Activity: 'cact',
  StatusHistory: 'cst',
} as const;

export function crmId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Who is acting on CRM data.
 *
 * Two identity domains reach these controllers and they are NOT the same principal:
 *  - `sales` — a CRM user (exec or manager) authenticated by phone OTP, living in Mongo.
 *  - `admin` — a platform admin authenticated by the existing Postgres `admin_accounts`.
 *    Admins have no CRM user row; they see everything and are attributed by name in the
 *    audit trail rather than by a CRM user id.
 */
export type CrmActor =
  | {
      kind: 'sales';
      id: string;
      name: string;
      role: Exclude<CrmRole, 'admin'>;
      managerId: string | null;
    }
  | { kind: 'admin'; id: string; name: string };

/** The CRM user id to attribute a write to — null for platform admins (no CRM user row). */
export function actorUserId(actor: CrmActor): string | null {
  return actor.kind === 'sales' ? actor.id : null;
}

/**
 * Which sales users' data may this actor see?
 *
 * `null` means "everyone" (platform admin). A manager sees their own reports plus themselves;
 * an exec sees only themselves. Every list query in the CRM runs through this.
 */
export async function visibleUserIds(actor: CrmActor): Promise<string[] | null> {
  if (actor.kind === 'admin') return null;
  if (actor.role === 'manager') {
    const users = await crm.users();
    const team = await users
      .find({ $or: [{ managerId: actor.id }, { _id: actor.id }] }, { projection: { _id: 1 } })
      .toArray();
    return team.map((u) => u._id);
  }
  return [actor.id];
}

/**
 * Build a Mongo filter fragment scoping `field` to what the actor may see.
 * Returns `{}` for an unrestricted actor so it can be spread into any filter.
 */
export function scopeFilter(
  ids: string[] | null,
  field: string,
): Record<string, unknown> {
  if (ids === null) return {};
  return { [field]: { $in: ids } };
}

/** Throw 403 unless the actor is allowed to touch this lead. */
export async function assertCanSeeRetailer(
  actor: CrmActor,
  retailer: Pick<CrmRetailer, 'assignedTo'>,
): Promise<void> {
  const ids = await visibleUserIds(actor);
  if (ids === null) return;
  if (!retailer.assignedTo || !ids.includes(retailer.assignedTo)) {
    throw new AppError(403, ErrorCode.Forbidden, 'This retailer is not assigned to you');
  }
}

/** Append to the audit trail. Never throws into the caller's happy path. */
export async function logActivity(input: {
  retailerId: string | null;
  actor: CrmActor;
  type: string;
  detail: string;
  at?: string;
}): Promise<void> {
  const activity = await crm.activity();
  await activity.insertOne({
    _id: crmId(CrmIdPrefix.Activity),
    retailerId: input.retailerId,
    userId: actorUserId(input.actor),
    actorName: input.actor.name,
    type: input.type,
    detail: input.detail,
    at: input.at ?? nowIso(),
  });
}

/** The set of checklist steps currently ticked for a lead. */
export async function doneSteps(retailerId: string): Promise<Set<CrmStepKey>> {
  const checklist = await crm.checklist();
  const rows = await checklist
    .find({ retailerId, done: true }, { projection: { stepKey: 1 } })
    .toArray();
  return new Set(rows.map((r) => r.stepKey));
}

/**
 * Recompute a lead's derived status and persist it if it moved.
 *
 * This is the ONLY writer of `retailers.status`. Every mutation (checklist tick, outcome,
 * follow-up create/complete) calls it last, so the status can never drift from the facts.
 * A transition also appends to `crm_status_history`, which is append-only.
 */
export async function recalcStatus(
  retailerId: string,
  actor: CrmActor,
): Promise<CrmStatus | null> {
  const retailers = await crm.retailers();
  const lead = await retailers.findOne(
    { _id: retailerId },
    { projection: { status: 1, notInterested: 1 } },
  );
  if (!lead) return null;

  const followups = await crm.followups();
  const pendingFollowups = await followups.countDocuments({ retailerId, status: 'pending' });
  const next = deriveCrmStatus(
    await doneSteps(retailerId),
    Boolean(lead.notInterested),
    pendingFollowups > 0,
  );

  if (next !== lead.status) {
    const at = nowIso();
    await retailers.updateOne({ _id: retailerId }, { $set: { status: next, updatedAt: at } });
    const history = await crm.statusHistory();
    await history.insertOne({
      _id: crmId(CrmIdPrefix.StatusHistory),
      retailerId,
      fromStatus: lead.status,
      toStatus: next,
      userId: actorUserId(actor),
      at,
    });
  }
  return next;
}

/** Bump `updatedAt` so the lead floats to the top of "recently worked" lists. */
export async function touchRetailer(retailerId: string): Promise<void> {
  const retailers = await crm.retailers();
  await retailers.updateOne({ _id: retailerId }, { $set: { updatedAt: nowIso() } });
}

/** A user's targets: their own override, else the global row, else the built-in default. */
export async function getTargets(userId: string): Promise<CrmTargets> {
  const targets = await crm.targets();
  const own = await targets.findOne({ userId });
  if (own) {
    return {
      visits: own.visits,
      demos: own.demos,
      agreements: own.agreements,
      onboardings: own.onboardings,
    };
  }
  const global = await targets.findOne({ userId: null });
  if (global) {
    return {
      visits: global.visits,
      demos: global.demos,
      agreements: global.agreements,
      onboardings: global.onboardings,
    };
  }
  return CRM_DEFAULT_TARGETS;
}

/** Batch variant of {@link getTargets} — one global read for a whole leaderboard. */
export async function getTargetsFor(userIds: string[]): Promise<Map<string, CrmTargets>> {
  const targets = await crm.targets();
  const rows = await targets.find({ $or: [{ userId: null }, { userId: { $in: userIds } }] }).toArray();
  const global = rows.find((r) => r.userId === null);
  const fallback: CrmTargets = global
    ? {
        visits: global.visits,
        demos: global.demos,
        agreements: global.agreements,
        onboardings: global.onboardings,
      }
    : CRM_DEFAULT_TARGETS;
  const out = new Map<string, CrmTargets>();
  for (const id of userIds) {
    const own = rows.find((r) => r.userId === id);
    out.set(
      id,
      own
        ? {
            visits: own.visits,
            demos: own.demos,
            agreements: own.agreements,
            onboardings: own.onboardings,
          }
        : fallback,
    );
  }
  return out;
}

/**
 * Ensure a visit row exists for this lead today, creating one if the rep ticked a checklist
 * step without checking in first. Progress implies presence — the visit count would otherwise
 * under-report a day's real work.
 *
 * Scoped to the acting user: two reps working the same store each get their own visit row,
 * so neither can accidentally attach to (or close) the other's check-in.
 */
export async function ensureTodayVisit(
  retailerId: string,
  userId: string,
  checkin?: { lat?: number | null; lng?: number | null },
): Promise<string> {
  const visits = await crm.visits();
  const today = crmLocalDay();

  const open = await visits.findOne(
    { retailerId, userId, date: today, checkOutAt: null },
    { sort: { createdAt: -1 } },
  );
  if (open) return open._id;

  // An already-closed visit today is reused for outcome/checklist writes, but an explicit
  // check-in starts a fresh one (a rep genuinely revisiting the store later the same day).
  if (!checkin) {
    const any = await visits.findOne({ retailerId, userId, date: today }, { sort: { createdAt: -1 } });
    if (any) return any._id;
  }

  const at = nowIso();
  const id = crmId(CrmIdPrefix.Visit);
  await visits.insertOne({
    _id: id,
    retailerId,
    userId,
    date: today,
    checkInAt: at,
    checkInLat: checkin?.lat ?? null,
    checkInLng: checkin?.lng ?? null,
    checkOutAt: null,
    outcome: null,
    outcomeReason: null,
    createdAt: at,
  });
  return id;
}

/** Load a lead or 404. */
export async function getRetailerOr404(id: string): Promise<CrmRetailer> {
  const retailers = await crm.retailers();
  const lead = await retailers.findOne({ _id: id });
  if (!lead) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  return lead;
}

/** Load a sales user or 404. */
export async function getUserOr404(id: string): Promise<CrmUser> {
  const users = await crm.users();
  const user = await users.findOne({ _id: id });
  if (!user) throw new AppError(404, ErrorCode.NotFound, 'Salesperson not found');
  return user;
}

/** Name lookup for a set of user ids — used to decorate list responses. */
export async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const users = await crm.users();
  const rows = await users
    .find({ _id: { $in: unique } }, { projection: { name: 1 } })
    .toArray();
  return new Map(rows.map((r) => [r._id, r.name]));
}
