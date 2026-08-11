import type {
  CrmActivity,
  CrmChecklistEntry,
  CrmDocument,
  CrmFollowup,
  CrmNote,
  CrmRetailer,
  CrmUser,
  CrmVisit,
} from './db/types.js';

/**
 * DTO layer for the CRM API.
 *
 * Mongo documents are camelCase (matching the rest of this backend). The wire contract the
 * retailer-crm frontend consumes is snake_case. Rather than let either convention bleed into
 * the other, every response is built through an explicit mapper here — so the moment a stored
 * field is renamed, the compiler points at the one place the wire shape must be reconsidered.
 *
 * These DTOs are the CRM module's public contract; nothing outside it depends on them.
 */

export type RetailerListDto = {
  id: string;
  store_name: string;
  owner_name: string | null;
  mobile: string | null;
  whatsapp: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  status: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  category: string | null;
  exec_name: string | null;
  last_visit: string | null;
  next_fu_date: string | null;
  next_fu_time: string | null;
};

export function shapeRetailerListItem(
  r: CrmRetailer,
  extra: {
    category: string | null;
    execName: string | null;
    lastVisit: string | null;
    nextFollowup: { date: string; time: string | null } | null;
  },
): RetailerListDto {
  return {
    id: r._id,
    store_name: r.storeName,
    owner_name: r.ownerName,
    mobile: r.mobile,
    whatsapp: r.whatsapp,
    area: r.area,
    city: r.city,
    pincode: r.pincode,
    status: r.status,
    assigned_to: r.assignedTo,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    category: extra.category,
    exec_name: extra.execName,
    last_visit: extra.lastVisit,
    next_fu_date: extra.nextFollowup?.date ?? null,
    next_fu_time: extra.nextFollowup?.time ?? null,
  };
}

export function shapeRetailerDetail(
  r: CrmRetailer,
  extra: { category: string | null; execName: string | null },
) {
  return {
    id: r._id,
    store_name: r.storeName,
    owner_name: r.ownerName,
    mobile: r.mobile,
    whatsapp: r.whatsapp,
    address: r.address,
    area: r.area,
    city: r.city,
    pincode: r.pincode,
    category_id: r.categoryId,
    notes: r.notes,
    status: r.status,
    not_interested: r.notInterested ? 1 : 0,
    not_interested_reason: r.notInterestedReason,
    assigned_to: r.assignedTo,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    category: extra.category,
    exec_name: extra.execName,
  };
}

export function shapeChecklistEntry(c: CrmChecklistEntry, doneByName: string | null) {
  return {
    step_key: c.stepKey,
    done: c.done ? 1 : 0,
    done_at: c.doneAt,
    done_by_name: doneByName,
  };
}

export function shapeVisit(v: CrmVisit, execName: string | null) {
  return {
    id: v._id,
    retailer_id: v.retailerId,
    user_id: v.userId,
    date: v.date,
    check_in_at: v.checkInAt,
    check_in_lat: v.checkInLat,
    check_in_lng: v.checkInLng,
    check_out_at: v.checkOutAt,
    outcome: v.outcome,
    outcome_reason: v.outcomeReason,
    created_at: v.createdAt,
    exec_name: execName,
  };
}

export function shapeNote(n: CrmNote, userName: string | null) {
  return { id: n._id, text: n.text, at: n.at, user_name: userName };
}

export function shapeFollowup(
  f: CrmFollowup,
  extra: { userName?: string | null; overdue?: boolean } = {},
) {
  return {
    id: f._id,
    retailer_id: f.retailerId,
    user_id: f.userId,
    date: f.date,
    time: f.time,
    type: f.type,
    reason: f.reason,
    notes: f.notes,
    status: f.status,
    created_at: f.createdAt,
    completed_at: f.completedAt,
    user_name: extra.userName ?? null,
    ...(extra.overdue !== undefined && { overdue: extra.overdue ? 1 : 0 }),
  };
}

/** Document metadata only — the `data` blob is always projected away before this runs. */
export function shapeDocument(d: Omit<CrmDocument, 'data'>, userName: string | null) {
  return {
    id: d._id,
    retailer_id: d.retailerId,
    kind: d.kind,
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    at: d.at,
    user_name: userName,
  };
}

export function shapeActivity(a: CrmActivity) {
  return {
    type: a.type,
    detail: a.detail,
    at: a.at,
    // Prefer the stored actor name so admin-performed actions stay attributed even
    // though platform admins have no CRM user row.
    user_name: a.actorName,
  };
}

export function shapeUserSummary(u: CrmUser) {
  return { id: u._id, name: u.name };
}
