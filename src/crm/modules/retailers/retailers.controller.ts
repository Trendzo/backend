import type { Filter } from 'mongodb';
import type { z } from 'zod';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import type { CrmRetailer } from '../../db/types.js';
import { crmLocalDay } from '../../domain.js';
import {
  assertCanSeeRetailer,
  CrmIdPrefix,
  crmId,
  getRetailerOr404,
  logActivity,
  nowIso,
  recalcStatus,
  scopeFilter,
  userNames,
  visibleUserIds,
  type CrmActor,
} from '../../store.js';
import {
  shapeActivity,
  shapeChecklistEntry,
  shapeDocument,
  shapeFollowup,
  shapeNote,
  shapeRetailerDetail,
  shapeRetailerListItem,
  shapeVisit,
} from '../../shape.js';
import type {
  CreateRetailerBody,
  ListRetailersQuery,
  UpdateRetailerBody,
} from './retailers.validators.js';

/** Escape a user string so it can sit inside a Mongo `$regex` as a literal. */
function rx(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** Normalised store name used for duplicate matching: letters+digits only, lowercased. */
function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Words too common in Indian retail signage to be evidence of a duplicate. Without this, the
 * same-area token rule below fires on almost every new lead — "Raj Fashion Store" and "Smoke
 * Test Store" share "store" and would be reported as the same shop. Duplicate warnings that
 * cry wolf get click-thrown, which defeats the whole feature.
 */
const GENERIC_NAME_WORDS = new Set([
  'store', 'stores', 'shop', 'shoppe', 'fashion', 'fashions', 'collection', 'collections',
  'garment', 'garments', 'cloth', 'clothing', 'clothes', 'textile', 'textiles', 'apparel',
  'apparels', 'boutique', 'centre', 'center', 'point', 'house', 'world', 'zone', 'hub',
  'mart', 'bazaar', 'bazar', 'emporium', 'traders', 'trading', 'enterprises', 'enterprise',
  'sons', 'brothers', 'company', 'creation', 'creations', 'style', 'styles', 'wear',
  'wears', 'gallery', 'palace', 'corner', 'plaza', 'super', 'new', 'the', 'and',
]);

/** Distinctive words in a store name — what a human would recognise the shop by. */
function distinctiveTokens(storeName: string): string[] {
  return storeName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !GENERIC_NAME_WORDS.has(t));
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listRetailers(input: {
  actor: CrmActor;
  query: z.infer<typeof ListRetailersQuery>;
}) {
  const { actor, query } = input;
  const retailers = await crm.retailers();
  const visible = await visibleUserIds(actor);

  const filter: Filter<CrmRetailer> = { ...scopeFilter(visible, 'assignedTo') };
  if (query.status) filter.status = query.status as CrmRetailer['status'];
  if (query.area) filter.area = query.area;
  if (query.city) filter.city = query.city;
  if (query.category) filter.categoryId = query.category;
  if (query.exec) filter.assignedTo = query.exec;
  if (query.from || query.to) {
    // `createdAt` is a full ISO timestamp; compare against day boundaries so a
    // date-range filter means whole local days, not "midnight to midnight UTC".
    const range: Record<string, string> = {};
    if (query.from) range.$gte = `${query.from}T00:00:00.000Z`;
    if (query.to) range.$lte = `${query.to}T23:59:59.999Z`;
    filter.createdAt = range;
  }
  if (query.q) {
    const pattern = rx(query.q);
    filter.$or = [
      { storeName: pattern },
      { ownerName: pattern },
      { mobile: pattern },
      { area: pattern },
    ];
  }

  // Follow-up filters need the follow-up collection first, then narrow the lead set.
  if (query.fu) {
    const followups = await crm.followups();
    const today = crmLocalDay();
    const ids = await followups.distinct('retailerId', {
      status: 'pending',
      date: query.fu === 'today' ? today : { $lt: today },
    });
    filter._id = { $in: ids };
  }

  const rows = await retailers
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(query.limit)
    .toArray();

  const decorated = await decorateRetailers(rows);
  return ok({ retailers: decorated, total: decorated.length, limit: query.limit });
}

/**
 * Attach the derived columns the list view shows — category name, assignee name, last visit,
 * next pending follow-up — in three batched queries rather than per row.
 */
async function decorateRetailers(rows: CrmRetailer[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r._id);

  const [categories, visits, followups] = await Promise.all([
    crm.categories(),
    crm.visits(),
    crm.followups(),
  ]);

  const [catRows, lastVisits, nextFollowups, names] = await Promise.all([
    categories
      .find({ _id: { $in: [...new Set(rows.map((r) => r.categoryId).filter(Boolean))] as string[] } })
      .toArray(),
    visits
      .aggregate<{ _id: string; lastVisit: string | null }>([
        { $match: { retailerId: { $in: ids } } },
        { $group: { _id: '$retailerId', lastVisit: { $max: '$checkInAt' } } },
      ])
      .toArray(),
    followups
      .find(
        { retailerId: { $in: ids }, status: 'pending' },
        { projection: { retailerId: 1, date: 1, time: 1 }, sort: { date: 1, time: 1 } },
      )
      .toArray(),
    userNames(rows.map((r) => r.assignedTo)),
  ]);

  const catName = new Map(catRows.map((c) => [c._id, c.name]));
  const lastVisit = new Map(lastVisits.map((v) => [v._id, v.lastVisit]));
  // Sorted ascending, so the first entry seen per lead is the soonest one.
  const nextFu = new Map<string, { date: string; time: string | null }>();
  for (const f of nextFollowups) {
    if (!nextFu.has(f.retailerId)) nextFu.set(f.retailerId, { date: f.date, time: f.time });
  }

  return rows.map((r) =>
    shapeRetailerListItem(r, {
      category: r.categoryId ? (catName.get(r.categoryId) ?? null) : null,
      execName: r.assignedTo ? (names.get(r.assignedTo) ?? null) : null,
      lastVisit: lastVisit.get(r._id) ?? null,
      nextFollowup: nextFu.get(r._id) ?? null,
    }),
  );
}

// ── Create (with duplicate detection) ────────────────────────────────────────

/**
 * Create a lead, refusing once with HTTP 409 if it looks like an existing one.
 *
 * Duplicate detection searches the WHOLE book on purpose — the failure it prevents is two reps
 * unknowingly working the same store, which only shows up across assignees. But a rep must not
 * learn a colleague's contact details as a side effect, so a candidate outside the caller's
 * scope is returned redacted: store name, area and who owns it (the actionable part), with the
 * owner name and phone withheld.
 */
export async function createRetailer(input: {
  actor: CrmActor;
  body: z.infer<typeof CreateRetailerBody>;
}) {
  const { actor, body } = input;
  const retailers = await crm.retailers();
  const storeName = body.store_name.trim();

  if (!body.force) {
    const duplicates = await findDuplicates(storeName, body.mobile ?? null, body.area ?? null);
    if (duplicates.length > 0) {
      const visible = await visibleUserIds(actor);
      const names = await userNames(duplicates.map((d) => d.assignedTo));
      const payload = duplicates.slice(0, 5).map((d) => {
        const mine = visible === null || (d.assignedTo !== null && visible.includes(d.assignedTo));
        return {
          id: mine ? d._id : null,
          store_name: d.storeName,
          area: d.area,
          status: d.status,
          exec_name: d.assignedTo ? (names.get(d.assignedTo) ?? null) : null,
          owner_name: mine ? d.ownerName : null,
          mobile: mine ? d.mobile : null,
          // Tells the UI whether to offer "open this lead" or just "someone else owns it".
          visible: mine,
        };
      });
      throw new AppError(409, ErrorCode.ValidationError, 'Possible existing retailer found.', {
        duplicates: payload,
      });
    }
  }

  // An admin may assign on create; a rep always owns what they create. A manager may
  // hand a new lead straight to one of their reps.
  const assignedTo = await resolveAssignee(actor, body.assigned_to ?? null);
  const at = nowIso();
  const id = crmId(CrmIdPrefix.Retailer);

  await retailers.insertOne({
    _id: id,
    storeName,
    ownerName: body.owner_name ?? null,
    mobile: body.mobile ?? null,
    whatsapp: body.whatsapp ?? body.mobile ?? null,
    address: body.address ?? null,
    area: body.area ?? null,
    city: body.city ?? null,
    pincode: body.pincode ?? null,
    categoryId: body.category_id ?? null,
    notes: body.notes ?? null,
    status: 'new',
    notInterested: false,
    notInterestedReason: null,
    assignedTo,
    createdBy: actor.kind === 'sales' ? actor.id : null,
    createdAt: at,
    updatedAt: at,
  });

  const assignments = await crm.assignments();
  await assignments.insertOne({
    _id: crmId(CrmIdPrefix.Assignment),
    retailerId: id,
    fromUser: null,
    toUser: assignedTo,
    changedBy: actor.kind === 'sales' ? actor.id : null,
    at,
  });

  await logActivity({
    retailerId: id,
    actor,
    type: 'retailer_created',
    detail: `Retailer added: ${storeName}`,
    at,
  });
  if (body.notes) {
    const notes = await crm.notes();
    await notes.insertOne({
      _id: crmId(CrmIdPrefix.Note),
      retailerId: id,
      userId: assignedTo,
      text: body.notes,
      at,
    });
    await logActivity({ retailerId: id, actor, type: 'note_added', detail: 'Note added', at });
  }

  return ok({ id });
}

/** Who should own a newly created or reassigned lead. */
async function resolveAssignee(actor: CrmActor, requested: string | null): Promise<string> {
  if (!requested) {
    if (actor.kind === 'sales') return actor.id;
    throw new AppError(
      400,
      ErrorCode.ValidationError,
      'Pick a salesperson to assign this retailer to',
    );
  }
  const users = await crm.users();
  const target = await users.findOne({ _id: requested, active: true });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Salesperson not found');
  if (actor.kind === 'sales') {
    // A rep can only ever assign to themselves; a manager may assign within their team.
    const visible = await visibleUserIds(actor);
    if (visible && !visible.includes(requested)) {
      throw new AppError(403, ErrorCode.Forbidden, 'That salesperson is not on your team');
    }
  }
  return requested;
}

/** Same-mobile, same-normalised-name, or heavy name overlap inside the same area. */
async function findDuplicates(
  storeName: string,
  mobile: string | null,
  area: string | null,
): Promise<CrmRetailer[]> {
  const retailers = await crm.retailers();
  const clauses: Filter<CrmRetailer>[] = [];

  if (mobile) clauses.push({ mobile });

  // Normalised-name equality can't be expressed as an index-friendly query, so match
  // case-insensitively on the raw name first and confirm the normalised form in JS.
  clauses.push({ storeName: new RegExp(`^${storeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });

  // A distinctive word reused by another store in the same area. Generic retail words are
  // excluded — see GENERIC_NAME_WORDS for why.
  const tokens = distinctiveTokens(storeName);
  if (area && tokens.length > 0) {
    clauses.push({ area, storeName: { $in: tokens.map((t) => rx(t)) } });
  }

  const candidates = await retailers.find({ $or: clauses }).limit(25).toArray();
  const target = normaliseName(storeName);
  return candidates.filter((c) => {
    if (mobile && c.mobile === mobile) return true;
    if (target && normaliseName(c.storeName) === target) return true;
    if (area && c.area === area && tokens.some((t) => c.storeName.toLowerCase().includes(t))) {
      return true;
    }
    return false;
  });
}

// ── Detail ───────────────────────────────────────────────────────────────────

/** Everything the lead detail screen renders, in one round trip. */
export async function getRetailerDetail(input: { actor: CrmActor; id: string }) {
  const { actor, id } = input;
  const retailer = await getRetailerOr404(id);
  await assertCanSeeRetailer(actor, retailer);

  const [checklistCol, visitsCol, notesCol, followupsCol, documentsCol, activityCol, assignmentsCol, categoriesCol] =
    await Promise.all([
      crm.checklist(),
      crm.visits(),
      crm.notes(),
      crm.followups(),
      crm.documents(),
      crm.activity(),
      crm.assignments(),
      crm.categories(),
    ]);

  const [checklist, visits, notes, followups, documents, activity, assignments, category] =
    await Promise.all([
      checklistCol.find({ retailerId: id }).toArray(),
      visitsCol.find({ retailerId: id }).sort({ createdAt: -1 }).toArray(),
      notesCol.find({ retailerId: id }).sort({ at: -1 }).toArray(),
      followupsCol.find({ retailerId: id }).toArray(),
      documentsCol
        .find({ retailerId: id }, { projection: { data: 0 } })
        .sort({ at: -1 })
        .toArray(),
      activityCol.find({ retailerId: id }).sort({ at: -1 }).limit(150).toArray(),
      assignmentsCol.find({ retailerId: id }).sort({ at: -1 }).toArray(),
      retailer.categoryId ? categoriesCol.findOne({ _id: retailer.categoryId }) : null,
    ]);

  const names = await userNames([
    retailer.assignedTo,
    ...checklist.map((c) => c.doneBy),
    ...visits.map((v) => v.userId),
    ...notes.map((n) => n.userId),
    ...followups.map((f) => f.userId),
    ...documents.map((d) => d.userId),
    ...assignments.flatMap((a) => [a.fromUser, a.toUser, a.changedBy]),
  ]);
  const nameOf = (uid: string | null) => (uid ? (names.get(uid) ?? null) : null);

  // Pending first, then soonest — the order the UI renders without re-sorting.
  const sortedFollowups = [...followups].sort((a, b) => {
    const rank = (s: string) => (s === 'pending' ? 0 : 1);
    return (
      rank(a.status) - rank(b.status) ||
      a.date.localeCompare(b.date) ||
      (a.time ?? '23:59').localeCompare(b.time ?? '23:59')
    );
  });

  // The rep's own open check-in, if any — drives the "N min on site" banner. Scoped to the
  // acting user so one rep never sees (or can close) another's open visit.
  const openVisit =
    actor.kind === 'sales'
      ? (visits.find((v) => v.userId === actor.id && v.checkInAt && !v.checkOutAt) ?? null)
      : (visits.find((v) => v.checkInAt && !v.checkOutAt) ?? null);

  return ok({
    retailer: shapeRetailerDetail(retailer, {
      category: category?.name ?? null,
      execName: nameOf(retailer.assignedTo),
    }),
    checklist: checklist.map((c) => shapeChecklistEntry(c, nameOf(c.doneBy))),
    visits: visits.map((v) => shapeVisit(v, nameOf(v.userId))),
    notes: notes.map((n) => shapeNote(n, nameOf(n.userId))),
    followups: sortedFollowups.map((f) => shapeFollowup(f, { userName: nameOf(f.userId) })),
    documents: documents.map((d) => shapeDocument(d, nameOf(d.userId))),
    activity: activity.map(shapeActivity),
    assignmentHistory: assignments.map((a) => ({
      at: a.at,
      from_name: nameOf(a.fromUser),
      to_name: nameOf(a.toUser),
      changed_by_name: nameOf(a.changedBy),
    })),
    openVisit: openVisit ? shapeVisit(openVisit, nameOf(openVisit.userId)) : null,
  });
}

// ── Update ───────────────────────────────────────────────────────────────────

const FIELD_MAP = {
  store_name: 'storeName',
  owner_name: 'ownerName',
  mobile: 'mobile',
  whatsapp: 'whatsapp',
  address: 'address',
  area: 'area',
  city: 'city',
  pincode: 'pincode',
  category_id: 'categoryId',
  notes: 'notes',
} as const;

export async function updateRetailer(input: {
  actor: CrmActor;
  id: string;
  body: z.infer<typeof UpdateRetailerBody>;
}) {
  const { actor, id, body } = input;
  const retailer = await getRetailerOr404(id);
  await assertCanSeeRetailer(actor, retailer);

  const set: Record<string, unknown> = {};
  for (const [wire, field] of Object.entries(FIELD_MAP)) {
    if (wire in body) set[field] = (body as Record<string, unknown>)[wire] ?? null;
  }
  if (Object.keys(set).length === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'Nothing to update');
  }
  set.updatedAt = nowIso();

  const retailers = await crm.retailers();
  await retailers.updateOne({ _id: id }, { $set: set });
  await logActivity({
    retailerId: id,
    actor,
    type: 'retailer_updated',
    detail: 'Store information updated',
  });
  // Category/name edits can't move the pipeline, but recalc is cheap and keeps the
  // invariant "status is always the derived value" unconditionally true.
  const status = await recalcStatus(id, actor);
  return ok({ ok: true, status });
}
