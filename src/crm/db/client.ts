import { MongoClient, type Collection, type Db, type IndexSpecification } from 'mongodb';
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type {
  CrmActivity,
  CrmAssignment,
  CrmCategory,
  CrmChecklistEntry,
  CrmDocument,
  CrmFollowup,
  CrmNote,
  CrmOtp,
  CrmRetailer,
  CrmStatusHistory,
  CrmTarget,
  CrmTerritory,
  CrmUser,
  CrmVisit,
} from './types.js';

/**
 * MongoDB handle for the field-sales CRM.
 *
 * This is a SECOND datastore, deliberately isolated from the platform's Postgres. The only
 * thing the CRM borrows from the platform is admin identity — an admin signs in through the
 * existing `/auth/admin/login` and carries a normal `kind: 'admin'` JWT into the CRM routes.
 * Every CRM record (leads, visits, follow-ups, sales users) lives here and has no foreign key,
 * join, or lifecycle link to the onboarded retailers in Postgres. A "retailer" in the CRM is a
 * prospect being worked by field sales; a "retailer" in the platform is an onboarded merchant.
 * They are different things and are intentionally never reconciled.
 *
 * Connection is lazy: the module never dials Mongo at import time, so the rest of the API boots
 * (and the whole existing test suite runs) with `CRM_MONGODB_URI` unset. CRM routes 503 until
 * it is configured.
 */

export const COLLECTIONS = {
  users: 'crm_users',
  otps: 'crm_otps',
  territories: 'crm_territories',
  categories: 'crm_categories',
  retailers: 'crm_retailers',
  assignments: 'crm_assignments',
  visits: 'crm_visits',
  checklist: 'crm_checklist',
  notes: 'crm_notes',
  followups: 'crm_followups',
  documents: 'crm_documents',
  targets: 'crm_targets',
  activity: 'crm_activity',
  statusHistory: 'crm_status_history',
} as const;

let client: MongoClient | null = null;
let connecting: Promise<Db> | null = null;
let cachedDb: Db | null = null;

/** Indexes mirroring the query shapes in the CRM controllers. Created once per process. */
const INDEXES: { collection: string; spec: IndexSpecification; unique?: boolean }[] = [
  { collection: COLLECTIONS.users, spec: { phone: 1 }, unique: true },
  { collection: COLLECTIONS.users, spec: { role: 1, active: -1, name: 1 } },
  { collection: COLLECTIONS.users, spec: { managerId: 1 } },
  { collection: COLLECTIONS.otps, spec: { phone: 1 } },
  // TTL sweep: expired OTPs delete themselves, so nothing accumulates.
  { collection: COLLECTIONS.otps, spec: { expiresAt: 1 } },
  { collection: COLLECTIONS.territories, spec: { city: 1, name: 1 } },
  { collection: COLLECTIONS.categories, spec: { name: 1 }, unique: true },
  { collection: COLLECTIONS.retailers, spec: { assignedTo: 1, status: 1 } },
  { collection: COLLECTIONS.retailers, spec: { updatedAt: -1 } },
  { collection: COLLECTIONS.retailers, spec: { mobile: 1 } },
  { collection: COLLECTIONS.retailers, spec: { area: 1 } },
  { collection: COLLECTIONS.assignments, spec: { retailerId: 1, at: -1 } },
  { collection: COLLECTIONS.visits, spec: { userId: 1, date: 1 } },
  { collection: COLLECTIONS.visits, spec: { retailerId: 1, date: 1 } },
  { collection: COLLECTIONS.visits, spec: { date: 1 } },
  { collection: COLLECTIONS.checklist, spec: { retailerId: 1, stepKey: 1 }, unique: true },
  { collection: COLLECTIONS.checklist, spec: { doneBy: 1, stepKey: 1, doneDate: 1 } },
  { collection: COLLECTIONS.notes, spec: { retailerId: 1, at: -1 } },
  { collection: COLLECTIONS.followups, spec: { userId: 1, status: 1, date: 1 } },
  { collection: COLLECTIONS.followups, spec: { retailerId: 1, status: 1, date: 1 } },
  { collection: COLLECTIONS.documents, spec: { retailerId: 1, at: -1 } },
  { collection: COLLECTIONS.documents, spec: { userId: 1, at: -1 } },
  { collection: COLLECTIONS.targets, spec: { userId: 1 }, unique: true },
  { collection: COLLECTIONS.activity, spec: { retailerId: 1, at: -1 } },
  { collection: COLLECTIONS.activity, spec: { userId: 1, at: -1 } },
  { collection: COLLECTIONS.statusHistory, spec: { retailerId: 1, at: -1 } },
];

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all(
    INDEXES.map(async (ix) => {
      try {
        await db
          .collection(ix.collection)
          .createIndex(ix.spec, ix.unique === true ? { unique: true } : {});
      } catch (err) {
        // A pre-existing index with the same keys but different options throws
        // IndexOptionsConflict (85) / IndexKeySpecsConflict (86). Neither is fatal —
        // the collection is still queryable — so log and continue rather than
        // wedging startup on a historical index.
        const code = (err as { code?: number }).code;
        if (code !== 85 && code !== 86) throw err;
      }
    }),
  );
  // TTL on OTPs is a separate concern from the plain lookup index above: Mongo
  // only allows one TTL spec per key, and it must be created with the option.
  try {
    await db.collection(COLLECTIONS.otps).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch {
    // Already exists with different options — harmless, sweeps still happen at verify time.
  }
}

/** True when a CRM datastore is configured. Routes use this to 503 cleanly. */
export function isCrmConfigured(): boolean {
  return Boolean(env.CRM_MONGODB_URI);
}

/**
 * Connect (once) and return the CRM database handle.
 *
 * @throws AppError 503 when `CRM_MONGODB_URI` is unset, so a missing config surfaces as a
 *   clear "CRM storage is not configured" rather than an opaque driver error.
 */
export async function crmDb(): Promise<Db> {
  if (cachedDb) return cachedDb;
  if (!env.CRM_MONGODB_URI) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'CRM storage is not configured (missing CRM_MONGODB_URI).',
    );
  }
  if (!connecting) {
    const uri = env.CRM_MONGODB_URI;
    connecting = (async () => {
      const c = new MongoClient(uri, {
        // Field reps work on flaky mobile networks behind the Next proxy; fail fast
        // and let the caller retry rather than hanging a request for 30s.
        serverSelectionTimeoutMS: 15_000,
        retryWrites: true,
      });
      await c.connect();
      client = c;
      const database = c.db(env.CRM_MONGODB_DB);
      await ensureIndexes(database);
      cachedDb = database;
      return database;
    })().catch((err: unknown) => {
      // Reset so a later request can retry the connection instead of latching the failure.
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

/** Typed collection accessors — every CRM query goes through one of these. */
export const crm = {
  users: async (): Promise<Collection<CrmUser>> =>
    (await crmDb()).collection<CrmUser>(COLLECTIONS.users),
  otps: async (): Promise<Collection<CrmOtp>> =>
    (await crmDb()).collection<CrmOtp>(COLLECTIONS.otps),
  territories: async (): Promise<Collection<CrmTerritory>> =>
    (await crmDb()).collection<CrmTerritory>(COLLECTIONS.territories),
  categories: async (): Promise<Collection<CrmCategory>> =>
    (await crmDb()).collection<CrmCategory>(COLLECTIONS.categories),
  retailers: async (): Promise<Collection<CrmRetailer>> =>
    (await crmDb()).collection<CrmRetailer>(COLLECTIONS.retailers),
  assignments: async (): Promise<Collection<CrmAssignment>> =>
    (await crmDb()).collection<CrmAssignment>(COLLECTIONS.assignments),
  visits: async (): Promise<Collection<CrmVisit>> =>
    (await crmDb()).collection<CrmVisit>(COLLECTIONS.visits),
  checklist: async (): Promise<Collection<CrmChecklistEntry>> =>
    (await crmDb()).collection<CrmChecklistEntry>(COLLECTIONS.checklist),
  notes: async (): Promise<Collection<CrmNote>> =>
    (await crmDb()).collection<CrmNote>(COLLECTIONS.notes),
  followups: async (): Promise<Collection<CrmFollowup>> =>
    (await crmDb()).collection<CrmFollowup>(COLLECTIONS.followups),
  documents: async (): Promise<Collection<CrmDocument>> =>
    (await crmDb()).collection<CrmDocument>(COLLECTIONS.documents),
  targets: async (): Promise<Collection<CrmTarget>> =>
    (await crmDb()).collection<CrmTarget>(COLLECTIONS.targets),
  activity: async (): Promise<Collection<CrmActivity>> =>
    (await crmDb()).collection<CrmActivity>(COLLECTIONS.activity),
  statusHistory: async (): Promise<Collection<CrmStatusHistory>> =>
    (await crmDb()).collection<CrmStatusHistory>(COLLECTIONS.statusHistory),
};

/** Close the pool — called from the server's shutdown path and by test teardown. */
export async function closeCrmDb(): Promise<void> {
  const c = client;
  client = null;
  cachedDb = null;
  connecting = null;
  if (c) await c.close();
}
