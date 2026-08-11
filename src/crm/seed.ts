import { Binary } from 'mongodb';
import { env } from '@/config/env.js';
import { closeCrmDb, COLLECTIONS, crm, crmDb } from './db/client.js';
import type { CrmStepKey } from './domain.js';
import { CRM_STEPS, crmLocalDay, deriveCrmStatus } from './domain.js';
import { CrmIdPrefix, crmId } from './store.js';

/**
 * Demo seed for the field-sales CRM.
 *
 * Everything is generated RELATIVE TO TODAY, so the dashboards are alive the moment you sign
 * in — a rep partway through their daily target, follow-ups due this morning, a couple of
 * stores overdue, some onboarded last week. A fixed-date fixture would show an empty "today"
 * and make every analytic look broken.
 *
 * Idempotent: re-running leaves an existing dataset alone. Pass `--reset` to wipe the CRM
 * collections and rebuild (this touches ONLY the crm_* collections — the platform's Postgres
 * is never involved).
 *
 * Usage:  npm run crm:seed          # seed if empty
 *         npm run crm:seed -- --reset
 */

const RESET = process.argv.includes('--reset');

/** Deterministic PRNG so a reseed produces the same fixture, not a different-looking one. */
function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** An instant N days ago at a given local wall-clock time, as an ISO string. */
function at(daysAgo: number, hour: number, minute: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** The local calendar day N days ago. */
function day(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return crmLocalDay(d);
}

type VisitSpec = { d: number; from?: number; to?: number };
type LeadSpec = {
  store: string;
  owner: string;
  area: string;
  cat: number;
  exec: number;
  created: number;
  visits: VisitSpec[];
  /** `d` is days from today: positive = future, 0 = today, negative = overdue. */
  fu?: { d: number; t: string; type: string; reason?: string; done?: boolean };
  ni?: string;
  note?: string;
};

const AREAS: Record<string, string> = {
  'Vijay Nagar': '452010',
  Palasia: '452001',
  Rau: '453331',
  'Scheme 54': '452010',
};

const CATEGORIES = ['Fashion', 'Footwear', 'Accessories', 'Lifestyle'];

const RAHUL = 0;
const AMAN = 1;
const PRIYA = 2;

const LEADS: LeadSpec[] = [
  // ── Rahul — today's six visits, five demos, three agreements, two onboarded today
  {
    store: 'Urban Shoes', owner: 'Sanjay Malviya', area: 'Vijay Nagar', cat: 1, exec: RAHUL, created: 3,
    visits: [{ d: 3, from: 0, to: 4 }, { d: 0, from: 5, to: 9 }],
    note: 'Owner interested. Wanted agreement on WhatsApp; discussed with partner and signed today.',
  },
  {
    store: 'Meena Sarees', owner: 'Meena Jain', area: 'Vijay Nagar', cat: 0, exec: RAHUL, created: 6,
    visits: [{ d: 6, from: 0, to: 2 }, { d: 0, from: 3, to: 6 }],
    note: 'Second visit went well. The demo on the owner’s own catalog convinced her. Agreement signed.',
  },
  {
    store: 'Denim District', owner: 'Arjun Bhatia', area: 'Scheme 54', cat: 0, exec: RAHUL, created: 0,
    visits: [{ d: 0, from: 0, to: 9 }],
    note: 'Single-visit close. Owner already sells online and wanted in immediately.',
  },
  {
    store: 'Fashion Point', owner: 'Ritesh Khandelwal', area: 'Vijay Nagar', cat: 0, exec: RAHUL, created: 0,
    visits: [{ d: 0, from: 0, to: 4 }],
    fu: { d: 1, t: '11:00', type: 'Phone Call', reason: 'Wants to discuss commission structure' },
  },
  {
    store: 'City Style', owner: 'Imran Qureshi', area: 'Scheme 54', cat: 0, exec: RAHUL, created: 0,
    visits: [{ d: 0, from: 0, to: 3 }],
    fu: { d: 2, t: '12:30', type: 'Store Visit', reason: 'Partner joins on next visit' },
  },
  {
    store: 'Kids Kloset', owner: 'Neha Agrawal', area: 'Vijay Nagar', cat: 3, exec: RAHUL, created: 0,
    visits: [{ d: 0, from: 0, to: 3 }],
    fu: { d: 3, t: '15:00', type: 'Demo', reason: 'Re-demo for the co-owner' },
  },
  // ── Rahul — follow-ups landing today, plus overdue ones
  {
    store: 'Raj Fashion Store', owner: 'Rajesh Purohit', area: 'Vijay Nagar', cat: 0, exec: RAHUL, created: 5,
    visits: [{ d: 5, from: 0, to: 1 }, { d: 3, from: 2, to: 5 }],
    fu: { d: 0, t: '10:30', type: 'Agreement', reason: 'Collect signed agreement' },
    note: 'Agreement shared on WhatsApp. Owner reviewing terms with brother.',
  },
  {
    store: 'Glamour House', owner: 'Pooja Sethi', area: 'Scheme 54', cat: 2, exec: RAHUL, created: 2,
    visits: [{ d: 2, from: 0, to: 2 }],
    fu: { d: 0, t: '12:00', type: 'Demo', reason: 'Demo pending, owner was busy' },
  },
  {
    store: 'Style Hub', owner: 'Vikram Nagpal', area: 'Vijay Nagar', cat: 0, exec: RAHUL, created: 7,
    visits: [{ d: 7, from: 0, to: 4 }, { d: 2, from: 5, to: 7 }],
    fu: { d: 0, t: '16:00', type: 'Signup', reason: 'Create account and complete signup' },
    note: 'Documents collected. Signup pending, needs GST login from the accountant.',
  },
  {
    store: 'Vastra Villa', owner: 'Kavita Rathore', area: 'Vijay Nagar', cat: 0, exec: RAHUL, created: 8,
    visits: [{ d: 8, from: 0, to: 3 }, { d: 4, from: 4, to: 5 }],
    fu: { d: -1, t: '15:00', type: 'Agreement', reason: 'Agreement shared, chase signature' },
  },
  {
    store: 'Silver Thread', owner: 'Harish Chandnani', area: 'Scheme 54', cat: 2, exec: RAHUL, created: 9,
    visits: [{ d: 9, from: 0, to: 4 }],
    fu: { d: -2, t: '11:00', type: 'Phone Call', reason: 'Went quiet after demo' },
  },
  {
    store: 'Trend Setter', owner: 'Mohit Wadhwani', area: 'Vijay Nagar', cat: 0, exec: RAHUL, created: 12,
    visits: [{ d: 12, from: 0, to: 4 }, { d: 9, from: 5, to: 7 }, { d: 6, from: 8, to: 9 }],
    fu: { d: -9, t: '12:00', type: 'Signup', reason: 'Complete signup', done: true },
    note: 'Fully onboarded. First catalog live.',
  },
  // ── Aman
  {
    store: 'Shoe Stop', owner: 'Deepak Sabnani', area: 'Palasia', cat: 1, exec: AMAN, created: 4,
    visits: [{ d: 4, from: 0, to: 5 }, { d: 0, from: 6, to: 9 }],
    note: 'Signed and onboarded. Wants footwear category banner.',
  },
  {
    store: 'Modern Man', owner: 'Sameer Lulla', area: 'Palasia', cat: 0, exec: AMAN, created: 0,
    visits: [{ d: 0, from: 0, to: 3 }],
    fu: { d: 1, t: '17:00', type: 'WhatsApp', reason: 'Send pricing deck' },
  },
  {
    store: 'Trendy Threads', owner: 'Ankit Chugh', area: 'Palasia', cat: 0, exec: AMAN, created: 2,
    visits: [{ d: 2, from: 0, to: 1 }, { d: 0, from: 2, to: 4 }],
    fu: { d: 1, t: '13:00', type: 'WhatsApp', reason: 'Share agreement copy' },
  },
  {
    store: 'Apna Bazaar Fashion', owner: 'Gopal Yadav', area: 'Palasia', cat: 0, exec: AMAN, created: 0,
    visits: [{ d: 0, from: 0, to: 3 }],
    fu: { d: 2, t: '11:30', type: 'Store Visit', reason: 'Owner wants family opinion' },
  },
  {
    store: 'Look & Co', owner: 'Farhan Shaikh', area: 'Palasia', cat: 0, exec: AMAN, created: 5,
    visits: [{ d: 5, from: 0, to: 3 }],
    ni: 'Already using competitor',
  },
  {
    store: 'Fit & Flare', owner: 'Shweta Kukreja', area: 'Palasia', cat: 0, exec: AMAN, created: 3,
    visits: [{ d: 3, from: 0, to: 5 }],
    fu: { d: 1, t: '12:00', type: 'Agreement', reason: 'Pick up signed copy' },
  },
  {
    store: 'Bella Boutique', owner: 'Rekha Motwani', area: 'Palasia', cat: 0, exec: AMAN, created: 6,
    visits: [{ d: 6, from: 0, to: 0 }],
    fu: { d: -1, t: '16:30', type: 'Demo', reason: 'Owner was away, demo pending' },
  },
  {
    store: 'Shree Fashion', owner: 'Lakhan Patidar', area: 'Palasia', cat: 0, exec: AMAN, created: 12,
    visits: [{ d: 12, from: 0, to: 6 }, { d: 8, from: 7, to: 9 }],
    note: 'Onboarded. Running festive offer this week.',
  },
  // ── Priya
  {
    store: 'Ethnic Elegance', owner: 'Sarita Solanki', area: 'Rau', cat: 0, exec: PRIYA, created: 0,
    visits: [{ d: 0, from: 0, to: 3 }],
    fu: { d: 1, t: '12:00', type: 'Phone Call', reason: 'Interested, confirm next step' },
  },
  {
    store: 'Kurti Corner', owner: 'Manju Choudhary', area: 'Rau', cat: 0, exec: PRIYA, created: 3,
    visits: [{ d: 3, from: 0, to: 2 }, { d: 0, from: 3, to: 4 }],
    fu: { d: 1, t: '15:30', type: 'Store Visit', reason: 'Bring agreement copy' },
  },
  {
    store: 'Sparsh Fashion', owner: 'Dinesh Mandloi', area: 'Rau', cat: 0, exec: PRIYA, created: 9,
    visits: [{ d: 9, from: 0, to: 4 }, { d: 4, from: 5, to: 7 }, { d: 1, from: 8, to: 8 }],
    note: 'Signup done, onboarding call scheduled with support.',
  },
  {
    store: 'The Label Room', owner: 'Ishita Bhandari', area: 'Rau', cat: 0, exec: PRIYA, created: 4,
    visits: [{ d: 4, from: 0, to: 3 }],
    ni: 'Pricing',
  },
  {
    store: 'Silk & Stone', owner: 'Ramesh Prajapat', area: 'Rau', cat: 2, exec: PRIYA, created: 8,
    visits: [{ d: 8, from: 0, to: 0 }],
    fu: { d: 1, t: '11:00', type: 'Store Visit', reason: 'Owner meets only on weekdays' },
  },
  { store: 'Wardrobe Story', owner: 'Alok Saxena', area: 'Rau', cat: 0, exec: PRIYA, created: 1, visits: [] },
];

export async function seedCrm(opts: { reset?: boolean } = {}): Promise<{
  seeded: boolean;
  users: { name: string; phone: string; role: string }[];
}> {
  const database = await crmDb();
  const users = await crm.users();

  if (opts.reset) {
    await Promise.all(
      Object.values(COLLECTIONS).map((name) => database.collection(name).deleteMany({})),
    );
  } else if ((await users.countDocuments()) > 0) {
    const existing = await users.find({}, { projection: { name: 1, phone: 1, role: 1 } }).toArray();
    return {
      seeded: false,
      users: existing.map((u) => ({ name: u.name, phone: u.phone, role: u.role })),
    };
  }

  const rnd = makeRandom(42);

  /**
   * Buffered writes.
   *
   * The seed used to issue one round trip per document — roughly 700 of them against a hosted
   * Atlas cluster, which took tens of seconds and made the e2e suite's reseeds the slowest and
   * least reliable thing in the run. These collections are write-only during the build, so
   * collecting them and issuing one insertMany each is identical in effect and ~20x faster.
   */
  const buf: Record<string, unknown[]> = {
    visits: [], checklist: [], notes: [], followups: [],
    activity: [], statusHistory: [], assignments: [], documents: [],
  };
  const [territories, categories, retailers, visits, checklist, notes, followups, targets, activity, statusHistory, assignments, documents] =
    await Promise.all([
      crm.territories(), crm.categories(), crm.retailers(), crm.visits(), crm.checklist(),
      crm.notes(), crm.followups(), crm.targets(), crm.activity(), crm.statusHistory(),
      crm.assignments(), crm.documents(),
    ]);

  // ── Reference data ─────────────────────────────────────────────────────────
  const territoryIds = new Map<string, string>();
  for (const area of Object.keys(AREAS)) {
    const id = crmId(CrmIdPrefix.Territory);
    territoryIds.set(area, id);
    await territories.insertOne({ _id: id, city: 'Indore', name: area, createdAt: at(60, 10, 0) });
  }
  const categoryIds: string[] = [];
  for (const name of CATEGORIES) {
    const id = crmId(CrmIdPrefix.Category);
    categoryIds.push(id);
    await categories.insertOne({ _id: id, name, createdAt: at(60, 10, 0) });
  }

  // ── Sales users ────────────────────────────────────────────────────────────
  // One manager plus three reps: enough for the leaderboard, the team page, and to prove
  // that a manager's scope is their own team while a rep's is only themselves.
  const managerId = crmId(CrmIdPrefix.User);
  await users.insertOne({
    _id: managerId,
    name: 'Sales Manager',
    phone: env.CRM_SEED_ADMIN_PHONE,
    role: 'manager',
    email: 'sales.manager@trendzo.in',
    employeeId: 'TZ-M01',
    territoryId: null,
    managerId: null,
    active: true,
    lastLoginAt: at(0, 9, 5),
    tokenVersion: 0,
    createdAt: at(60, 10, 0),
  });

  const execSpecs = [
    { name: 'Rahul Sharma', phone: env.CRM_SEED_EXEC_PHONE, emp: 'TZ-101', area: 'Vijay Nagar', login: at(0, 9, 40) },
    { name: 'Aman Verma', phone: '9000000012', emp: 'TZ-102', area: 'Palasia', login: at(1, 18, 20) },
    { name: 'Priya Singh', phone: '9000000013', emp: 'TZ-103', area: 'Rau', login: at(2, 17, 10) },
  ];
  const execIds: string[] = [];
  for (const spec of execSpecs) {
    const id = crmId(CrmIdPrefix.User);
    execIds.push(id);
    await users.insertOne({
      _id: id,
      name: spec.name,
      phone: spec.phone,
      role: 'exec',
      email: null,
      employeeId: spec.emp,
      territoryId: territoryIds.get(spec.area) ?? null,
      managerId,
      active: true,
      lastLoginAt: spec.login,
      tokenVersion: 0,
      createdAt: at(60, 10, 0),
    });
  }

  await targets.insertOne({
    _id: crmId(CrmIdPrefix.Target),
    userId: null,
    visits: 10,
    demos: 7,
    agreements: 4,
    onboardings: 2,
  });

  // ── Leads with their full history ──────────────────────────────────────────
  const leadIdByStore = new Map<string, string>();

  for (const [i, spec] of LEADS.entries()) {
    const execId = execIds[spec.exec]!;
    const mobile = `98930${10000 + i}`;
    const createdAt = at(spec.created, 9, 30 + Math.floor(rnd() * 20));
    const leadId = crmId(CrmIdPrefix.Retailer);
    leadIdByStore.set(spec.store, leadId);

    const doneSet = new Set<CrmStepKey>();
    for (const v of spec.visits) {
      if (v.from === undefined) continue;
      for (let k = v.from; k <= v.to!; k++) doneSet.add(CRM_STEPS[k]!.key);
    }
    const pendingFu = Boolean(spec.fu) && !spec.fu?.done;
    const status = deriveCrmStatus(doneSet, Boolean(spec.ni), pendingFu);

    let lastCheckout = createdAt;

    await retailers.insertOne({
      _id: leadId,
      storeName: spec.store,
      ownerName: spec.owner,
      mobile,
      whatsapp: mobile,
      address: `${12 + i}, ${spec.area} Main Road`,
      area: spec.area,
      city: 'Indore',
      pincode: AREAS[spec.area] ?? null,
      categoryId: categoryIds[spec.cat] ?? null,
      notes: null,
      status,
      notInterested: Boolean(spec.ni),
      notInterestedReason: spec.ni ?? null,
      assignedTo: execId,
      createdBy: execId,
      createdAt,
      updatedAt: createdAt,
    });

    buf.assignments!.push({
      _id: crmId(CrmIdPrefix.Assignment),
      retailerId: leadId,
      fromUser: null,
      toUser: execId,
      changedBy: execId,
      at: createdAt,
    });
    buf.activity!.push({
      _id: crmId(CrmIdPrefix.Activity),
      retailerId: leadId,
      userId: execId,
      actorName: execSpecs[spec.exec]!.name,
      type: 'retailer_created',
      detail: `Retailer added: ${spec.store}`,
      at: createdAt,
    });

    for (const [vi, v] of spec.visits.entries()) {
      const checkIn = at(v.d, 10 + ((i + vi) % 6), 5 + Math.floor(rnd() * 40));
      const stepCount = v.from === undefined ? 0 : v.to! - v.from! + 1;
      const checkOut = new Date(
        Date.parse(checkIn) + (22 + stepCount * 5 + Math.floor(rnd() * 10)) * 60_000,
      ).toISOString();
      lastCheckout = checkOut;

      const isLast = vi === spec.visits.length - 1;
      const endStep = v.to ?? -1;
      let outcome: string | null = null;
      let outcomeReason: string | null = null;
      if (isLast) {
        if (spec.ni) {
          outcome = 'not_interested';
          outcomeReason = spec.ni;
        } else if (endStep >= 9) outcome = 'onboarded';
        else if (endStep >= 6) outcome = 'agreement_done';
        else if (endStep === 5) outcome = 'agreement_pending';
        else if (endStep >= 3) outcome = pendingFu && (spec.fu?.d ?? 1) >= 0 ? 'followup_required' : 'interested';
        else if (endStep >= 0) outcome = 'followup_required';
      }

      buf.visits!.push({
        _id: crmId(CrmIdPrefix.Visit),
        retailerId: leadId,
        userId: execId,
        date: day(v.d),
        checkInAt: checkIn,
        checkInLat: Math.round((22.72 + rnd() * 0.05) * 1e6) / 1e6,
        checkInLng: Math.round((75.86 + rnd() * 0.05) * 1e6) / 1e6,
        checkOutAt: checkOut,
        outcome,
        outcomeReason,
        createdAt: checkIn,
      });
      buf.activity!.push({
        _id: crmId(CrmIdPrefix.Activity),
        retailerId: leadId,
        userId: execId,
        actorName: execSpecs[spec.exec]!.name,
        type: 'checkin',
        detail: 'Checked in at store',
        at: checkIn,
      });

      if (v.from !== undefined) {
        for (let k = v.from; k <= v.to!; k++) {
          const step = CRM_STEPS[k]!;
          const doneAt = new Date(Date.parse(checkIn) + (k - v.from + 1) * 4 * 60_000).toISOString();
          buf.checklist!.push({
            _id: crmId(CrmIdPrefix.Checklist),
            retailerId: leadId,
            stepKey: step.key,
            done: true,
            doneBy: execId,
            doneAt,
            doneDate: day(v.d),
          });
          buf.activity!.push({
            _id: crmId(CrmIdPrefix.Activity),
            retailerId: leadId,
            userId: execId,
            actorName: execSpecs[spec.exec]!.name,
            type: 'step_done',
            detail: step.label,
            at: doneAt,
          });
        }
      }

      buf.activity!.push({
        _id: crmId(CrmIdPrefix.Activity),
        retailerId: leadId,
        userId: execId,
        actorName: execSpecs[spec.exec]!.name,
        type: 'checkout',
        detail: 'Checked out',
        at: checkOut,
      });
      if (outcome) {
        buf.activity!.push({
          _id: crmId(CrmIdPrefix.Activity),
          retailerId: leadId,
          userId: execId,
          actorName: execSpecs[spec.exec]!.name,
          type: 'outcome_set',
          detail: `Visit outcome: ${outcome.replace(/_/g, ' ')}${outcomeReason ? ` (${outcomeReason})` : ''}`,
          at: checkOut,
        });
      }
    }

    if (spec.note) {
      buf.notes!.push({
        _id: crmId(CrmIdPrefix.Note),
        retailerId: leadId,
        userId: execId,
        text: spec.note,
        at: lastCheckout,
      });
      buf.activity!.push({
        _id: crmId(CrmIdPrefix.Activity),
        retailerId: leadId,
        userId: execId,
        actorName: execSpecs[spec.exec]!.name,
        type: 'note_added',
        detail: 'Note added',
        at: lastCheckout,
      });
    }

    if (spec.fu) {
      buf.followups!.push({
        _id: crmId(CrmIdPrefix.Followup),
        retailerId: leadId,
        userId: execId,
        date: day(-spec.fu.d),
        time: spec.fu.t,
        type: spec.fu.type,
        reason: spec.fu.reason ?? null,
        notes: null,
        status: spec.fu.done ? 'done' : 'pending',
        createdAt: lastCheckout,
        completedAt: spec.fu.done ? at(Math.max(0, -spec.fu.d), 13, 0) : null,
      });
      buf.activity!.push({
        _id: crmId(CrmIdPrefix.Activity),
        retailerId: leadId,
        userId: execId,
        actorName: execSpecs[spec.exec]!.name,
        type: 'followup_scheduled',
        detail: `${spec.fu.type} follow-up scheduled for ${day(-spec.fu.d)} ${spec.fu.t}`,
        at: lastCheckout,
      });
    }

    await retailers.updateOne({ _id: leadId }, { $set: { updatedAt: lastCheckout } });
    buf.statusHistory!.push({
      _id: crmId(CrmIdPrefix.StatusHistory),
      retailerId: leadId,
      fromStatus: 'new',
      toStatus: status,
      userId: execId,
      at: lastCheckout,
    });
  }

  // ── A couple of documents so the docs views aren't empty ────────────────────
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const docSpecs = [
    { store: 'Urban Shoes', exec: RAHUL, kind: 'Store Photo', file: 'urban-shoes-front.png', mime: 'image/png', buf: png, hour: 11, min: 20 },
    { store: 'Urban Shoes', exec: RAHUL, kind: 'Signed Agreement', file: 'urban-shoes-agreement.pdf', mime: 'application/pdf', buf: pdf, hour: 11, min: 45 },
    { store: 'Shoe Stop', exec: AMAN, kind: 'Signed Agreement', file: 'shoe-stop-agreement.pdf', mime: 'application/pdf', buf: pdf, hour: 12, min: 40 },
  ];
  for (const d of docSpecs) {
    const leadId = leadIdByStore.get(d.store);
    if (!leadId) continue;
    const stamp = at(0, d.hour, d.min);
    buf.documents!.push({
      _id: crmId(CrmIdPrefix.Document),
      retailerId: leadId,
      userId: execIds[d.exec]!,
      kind: d.kind,
      filename: d.file,
      mime: d.mime,
      size: d.buf.byteLength,
      data: new Binary(d.buf),
      at: stamp,
    });
    buf.activity!.push({
      _id: crmId(CrmIdPrefix.Activity),
      retailerId: leadId,
      userId: execIds[d.exec]!,
      actorName: execSpecs[d.exec]!.name,
      type: 'doc_uploaded',
      detail: `Uploaded ${d.kind}`,
      at: stamp,
    });
  }

  // One write per collection instead of hundreds.
  await Promise.all([
    buf.visits!.length ? visits.insertMany(buf.visits as never) : null,
    buf.checklist!.length ? checklist.insertMany(buf.checklist as never) : null,
    buf.notes!.length ? notes.insertMany(buf.notes as never) : null,
    buf.followups!.length ? followups.insertMany(buf.followups as never) : null,
    buf.activity!.length ? activity.insertMany(buf.activity as never) : null,
    buf.statusHistory!.length ? statusHistory.insertMany(buf.statusHistory as never) : null,
    buf.assignments!.length ? assignments.insertMany(buf.assignments as never) : null,
    buf.documents!.length ? documents.insertMany(buf.documents as never) : null,
  ]);

  return {
    seeded: true,
    users: [
      { name: 'Sales Manager', phone: env.CRM_SEED_ADMIN_PHONE, role: 'manager' },
      ...execSpecs.map((e) => ({ name: e.name, phone: e.phone, role: 'exec' })),
    ],
  };
}

// Run directly: `npm run crm:seed [-- --reset]`
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('/crm/seed');
if (isDirectRun) {
  seedCrm({ reset: RESET })
    .then((result) => {
      /* eslint-disable no-console */
      if (result.seeded) {
        console.log(`\n✔ CRM seeded into "${env.CRM_MONGODB_DB}".\n`);
      } else {
        console.log(`\n• CRM already has data — nothing written. Use --reset to rebuild.\n`);
      }
      console.log('  Sales sign-in (phone + OTP):');
      for (const u of result.users) {
        console.log(`    ${u.phone}  ${u.name} (${u.role})`);
      }
      console.log(`\n  Admin sign-in: ${env.ADMIN_SEED_EMAIL} / ${env.ADMIN_SEED_PASSWORD}`);
      console.log('  (the existing platform admin — same account as the web portal)\n');
      /* eslint-enable no-console */
      return closeCrmDb();
    })
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('CRM seed failed:', err);
      process.exit(1);
    });
}
