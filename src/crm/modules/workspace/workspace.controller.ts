import type { Filter } from 'mongodb';
import type { z } from 'zod';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import type { CrmFollowup, CrmVisit } from '../../db/types.js';
import { crmLocalDay } from '../../domain.js';
import {
  CrmIdPrefix,
  crmId,
  logActivity,
  nowIso,
  scopeFilter,
  userNames,
  visibleUserIds,
  type CrmActor,
} from '../../store.js';
import { shapeFollowup, shapeVisit } from '../../shape.js';
import type { ListFollowupsQuery, ListVisitsQuery } from '../retailers/retailers.validators.js';

/**
 * Cross-cutting reads and the small reference collections: the follow-up queue, the visit log,
 * plus categories and territories. All scoped by {@link visibleUserIds} so a rep sees their own
 * work, a manager their team's, and an admin everything.
 */

// ── Follow-ups ───────────────────────────────────────────────────────────────

export async function listFollowups(input: {
  actor: CrmActor;
  query: z.infer<typeof ListFollowupsQuery>;
}) {
  const { actor, query } = input;
  const followups = await crm.followups();
  const visible = await visibleUserIds(actor);
  const today = crmLocalDay();

  const filter: Filter<CrmFollowup> = { ...scopeFilter(visible, 'userId') };
  switch (query.scope) {
    case 'today':
      filter.status = 'pending';
      filter.date = today;
      break;
    case 'overdue':
      filter.status = 'pending';
      filter.date = { $lt: today };
      break;
    case 'upcoming':
      filter.status = 'pending';
      filter.date = { $gt: today };
      break;
    case 'pending':
      filter.status = 'pending';
      break;
    case 'done':
      filter.status = { $in: ['done', 'cancelled'] };
      break;
    case 'all':
      break;
  }
  if (query.exec) filter.userId = query.exec;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range.$gte = query.from;
    if (query.to) range.$lte = query.to;
    // A scope may already have constrained `date`; merge rather than clobber.
    filter.date = typeof filter.date === 'object' && filter.date !== null && !Array.isArray(filter.date)
      ? { ...(filter.date as Record<string, string>), ...range }
      : range;
  }

  const rows = await followups.find(filter).sort({ date: 1, time: 1 }).limit(500).toArray();
  const [retailersCol, names] = await Promise.all([
    crm.retailers(),
    userNames(rows.map((r) => r.userId)),
  ]);
  const leads = await retailersCol
    .find(
      { _id: { $in: [...new Set(rows.map((r) => r.retailerId))] } },
      { projection: { storeName: 1, area: 1, status: 1 } },
    )
    .toArray();
  const leadOf = new Map(leads.map((l) => [l._id, l]));

  return ok({
    followups: rows.map((f) => ({
      ...shapeFollowup(f, {
        userName: names.get(f.userId) ?? null,
        overdue: f.status === 'pending' && f.date < today,
      }),
      store_name: leadOf.get(f.retailerId)?.storeName ?? null,
      area: leadOf.get(f.retailerId)?.area ?? null,
      retailer_status: leadOf.get(f.retailerId)?.status ?? null,
      exec_name: names.get(f.userId) ?? null,
    })),
  });
}

// ── Visits ───────────────────────────────────────────────────────────────────

export async function listVisits(input: {
  actor: CrmActor;
  query: z.infer<typeof ListVisitsQuery>;
}) {
  const { actor, query } = input;
  const visits = await crm.visits();
  const visible = await visibleUserIds(actor);

  const filter: Filter<CrmVisit> = { ...scopeFilter(visible, 'userId') };
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range.$gte = query.from;
    if (query.to) range.$lte = query.to;
    filter.date = range;
  }
  if (query.exec) filter.userId = query.exec;
  if (query.retailer) filter.retailerId = query.retailer;

  const rows = await visits.find(filter).sort({ checkInAt: -1, createdAt: -1 }).limit(500).toArray();
  const [retailersCol, names] = await Promise.all([
    crm.retailers(),
    userNames(rows.map((r) => r.userId)),
  ]);
  const leads = await retailersCol
    .find(
      { _id: { $in: [...new Set(rows.map((r) => r.retailerId))] } },
      { projection: { storeName: 1, area: 1, status: 1 } },
    )
    .toArray();
  const leadOf = new Map(leads.map((l) => [l._id, l]));

  return ok({
    visits: rows.map((v) => ({
      ...shapeVisit(v, names.get(v.userId) ?? null),
      store_name: leadOf.get(v.retailerId)?.storeName ?? null,
      area: leadOf.get(v.retailerId)?.area ?? null,
      retailer_status: leadOf.get(v.retailerId)?.status ?? null,
    })),
  });
}

// ── Categories ───────────────────────────────────────────────────────────────

export async function listCategories() {
  const [categories, retailers] = await Promise.all([crm.categories(), crm.retailers()]);
  const rows = await categories.find({}).sort({ name: 1 }).toArray();
  const counts = await retailers
    .aggregate<{ _id: string | null; n: number }>([
      { $match: { categoryId: { $ne: null } } },
      { $group: { _id: '$categoryId', n: { $sum: 1 } } },
    ])
    .toArray();
  const countOf = new Map(counts.map((c) => [c._id, c.n]));
  return ok({
    categories: rows.map((c) => ({ id: c._id, name: c.name, retailers: countOf.get(c._id) ?? 0 })),
  });
}

export async function createCategory(input: { actor: CrmActor; name: string }) {
  const categories = await crm.categories();
  const name = input.name.trim();
  if (!name) throw new AppError(400, ErrorCode.ValidationError, 'Category name is required');
  const clash = await categories.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  if (clash) throw new AppError(409, ErrorCode.ValidationError, 'This category already exists');
  const id = crmId(CrmIdPrefix.Category);
  await categories.insertOne({ _id: id, name, createdAt: nowIso() });
  await logActivity({
    retailerId: null,
    actor: input.actor,
    type: 'category_created',
    detail: `Category added: ${name}`,
  });
  return ok({ id });
}

export async function deleteCategory(input: { actor: CrmActor; id: string }) {
  const [categories, retailers] = await Promise.all([crm.categories(), crm.retailers()]);
  const category = await categories.findOne({ _id: input.id });
  if (!category) throw new AppError(404, ErrorCode.NotFound, 'Category not found');
  const used = await retailers.countDocuments({ categoryId: input.id });
  if (used > 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `${used} retailer${used === 1 ? '' : 's'} use this category. Reassign them first.`,
    );
  }
  await categories.deleteOne({ _id: input.id });
  await logActivity({
    retailerId: null,
    actor: input.actor,
    type: 'category_deleted',
    detail: `Category removed: ${category.name}`,
  });
  return ok({ ok: true });
}

// ── Territories ──────────────────────────────────────────────────────────────

export async function listTerritories() {
  const [territories, users, retailers] = await Promise.all([
    crm.territories(),
    crm.users(),
    crm.retailers(),
  ]);
  const rows = await territories.find({}).sort({ city: 1, name: 1 }).toArray();
  const staff = await users
    .find({ active: true, territoryId: { $ne: null } }, { projection: { name: 1, territoryId: 1 } })
    .toArray();
  // Territories map to leads by AREA NAME, not by id: a lead's area is free text a rep types
  // in the field, and forcing a foreign key there would drop any store in a locality nobody
  // has formalised yet.
  const counts = await retailers
    .aggregate<{ _id: string | null; n: number }>([{ $group: { _id: '$area', n: { $sum: 1 } } }])
    .toArray();
  const countOf = new Map(counts.map((c) => [c._id, c.n]));

  return ok({
    territories: rows.map((t) => ({
      id: t._id,
      city: t.city,
      name: t.name,
      execs:
        staff
          .filter((s) => s.territoryId === t._id)
          .map((s) => s.name)
          .join(', ') || null,
      retailers: countOf.get(t.name) ?? 0,
    })),
  });
}

export async function createTerritory(input: { actor: CrmActor; city: string; name: string }) {
  const city = input.city.trim();
  const name = input.name.trim();
  if (!city || !name) {
    throw new AppError(400, ErrorCode.ValidationError, 'City and area name are required');
  }
  const territories = await crm.territories();
  const clash = await territories.findOne({
    city: new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  });
  if (clash) throw new AppError(409, ErrorCode.ValidationError, 'That territory already exists');
  const id = crmId(CrmIdPrefix.Territory);
  await territories.insertOne({ _id: id, city, name, createdAt: nowIso() });
  await logActivity({
    retailerId: null,
    actor: input.actor,
    type: 'territory_created',
    detail: `Territory added: ${city} · ${name}`,
  });
  return ok({ id });
}

export async function deleteTerritory(input: { actor: CrmActor; id: string }) {
  const [territories, users] = await Promise.all([crm.territories(), crm.users()]);
  const territory = await territories.findOne({ _id: input.id });
  if (!territory) throw new AppError(404, ErrorCode.NotFound, 'Territory not found');
  const assigned = await users.countDocuments({ territoryId: input.id });
  if (assigned > 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Reassign salespeople out of this territory first',
    );
  }
  await territories.deleteOne({ _id: input.id });
  await logActivity({
    retailerId: null,
    actor: input.actor,
    type: 'territory_deleted',
    detail: `Territory removed: ${territory.city} · ${territory.name}`,
  });
  return ok({ ok: true });
}
