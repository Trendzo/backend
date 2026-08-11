import type { Binary } from 'mongodb';
import type { CrmRole, CrmStatus, CrmStepKey } from '../domain.js';

/**
 * Document shapes for the field-sales CRM's MongoDB collections.
 *
 * Every document uses a string `_id` we mint ourselves (`crmId()`), not an ObjectId — the ids
 * travel to the browser, appear in URLs, and are compared as strings throughout, so an opaque
 * string keeps the whole stack free of ObjectId serialisation quirks.
 *
 * Two date conventions run side by side, deliberately:
 *  - `*At` fields are full ISO-8601 UTC timestamps (`2026-08-08T09:15:00.000Z`).
 *  - `date` / `doneDate` fields are LOCAL calendar days (`2026-08-08`) in the CRM's reporting
 *    timezone. A field rep's "today" is a wall-clock day, so daily targets, visit counts, and
 *    date-range reports all bucket on the local day, never on UTC.
 */

export type CrmUser = {
  _id: string;
  name: string;
  /** 10-digit national number. The sales login matches on this. */
  phone: string;
  role: CrmRole;
  email: string | null;
  employeeId: string | null;
  territoryId: string | null;
  managerId: string | null;
  active: boolean;
  lastLoginAt: string | null;
  /**
   * Bumped to invalidate every token already issued to this user. Sales sessions are plain
   * JWTs with no server-side session table, so this counter is the revocation mechanism
   * behind "reset access" and deactivation.
   */
  tokenVersion: number;
  createdAt: string;
};

export type CrmOtp = {
  _id: string;
  phone: string;
  code: string;
  attempts: number;
  expiresAt: Date;
  createdAt: string;
};

export type CrmTerritory = {
  _id: string;
  city: string;
  name: string;
  createdAt: string;
};

export type CrmCategory = {
  _id: string;
  name: string;
  createdAt: string;
};

/**
 * A CRM lead. NOT the platform's onboarded retailer — no link, no shared id, no sync.
 * `status` is derived (never hand-set) from checklist progress + pending follow-ups.
 */
export type CrmRetailer = {
  _id: string;
  storeName: string;
  ownerName: string | null;
  mobile: string | null;
  whatsapp: string | null;
  address: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  categoryId: string | null;
  notes: string | null;
  status: CrmStatus;
  notInterested: boolean;
  notInterestedReason: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CrmAssignment = {
  _id: string;
  retailerId: string;
  fromUser: string | null;
  toUser: string;
  changedBy: string | null;
  at: string;
};

export type CrmVisit = {
  _id: string;
  retailerId: string;
  userId: string;
  /** Local calendar day (YYYY-MM-DD) the visit belongs to. */
  date: string;
  checkInAt: string | null;
  checkInLat: number | null;
  checkInLng: number | null;
  checkOutAt: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  createdAt: string;
};

export type CrmChecklistEntry = {
  _id: string;
  retailerId: string;
  stepKey: CrmStepKey;
  done: boolean;
  doneBy: string | null;
  doneAt: string | null;
  /** Local calendar day the step was ticked — this is what daily/period stats count. */
  doneDate: string | null;
};

export type CrmNote = {
  _id: string;
  retailerId: string;
  userId: string;
  text: string;
  at: string;
};

export type CrmFollowupStatus = 'pending' | 'done' | 'cancelled';

export type CrmFollowup = {
  _id: string;
  retailerId: string;
  userId: string;
  /** Local calendar day the follow-up is due. */
  date: string;
  time: string | null;
  type: string;
  reason: string | null;
  notes: string | null;
  status: CrmFollowupStatus;
  createdAt: string;
  completedAt: string | null;
};

/**
 * Uploaded document. The bytes live in `data` as BSON Binary — capped at 8 MB by the upload
 * route, comfortably inside Mongo's 16 MB document ceiling. Every list query projects `data`
 * away so a directory listing never drags blobs across the wire.
 */
export type CrmDocument = {
  _id: string;
  retailerId: string;
  userId: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  data: Binary;
  at: string;
};

export type CrmTarget = {
  _id: string;
  /** null = the global default every user falls back to. */
  userId: string | null;
  visits: number;
  demos: number;
  agreements: number;
  onboardings: number;
};

export type CrmActivity = {
  _id: string;
  retailerId: string | null;
  userId: string | null;
  /** Actor label for admin-performed actions, so the audit trail names a human. */
  actorName: string | null;
  type: string;
  detail: string;
  at: string;
};

export type CrmStatusHistory = {
  _id: string;
  retailerId: string;
  fromStatus: CrmStatus | null;
  toStatus: CrmStatus;
  userId: string | null;
  at: string;
};
