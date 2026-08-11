import type { z } from 'zod';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import {
  CRM_STATUS_LABEL,
  crmDaySpan,
  crmLocalDay,
  crmPct,
  type CrmStatus,
  type CrmStepKey,
} from '../../domain.js';
import { getTargetsFor, visibleUserIds, type CrmActor } from '../../store.js';
import type { ReportQuery } from './team.validators.js';

/**
 * CRM reports, served as JSON for on-screen preview or CSV for download.
 *
 * Four shapes:
 *  - `performance` / `daily` — one row per salesperson over the range, differing only in
 *    which trailing columns they carry (averages vs. target achievement).
 *  - `conversion` — one row per lead with the date it crossed each pipeline stage, which is
 *    what makes "how long does a store take to onboard" answerable.
 *  - `followups` — the follow-up ledger for the range.
 */

type Row = Record<string, string | number>;

/** RFC-4180 CSV. Fields containing a comma, quote or newline get quoted; quotes doubled. */
export function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
  ].join('\n');
}

export async function buildReport(input: {
  actor: CrmActor;
  query: z.infer<typeof ReportQuery>;
}): Promise<{ rows: Row[]; from: string; to: string; filename: string }> {
  const { actor, query } = input;
  const today = crmLocalDay();
  const from = query.from ?? today;
  const to = query.to ?? today;

  const users = await crm.users();
  const visible = await visibleUserIds(actor);
  const staffFilter: Record<string, unknown> = {
    role: { $in: ['exec', 'manager'] },
    active: true,
  };
  if (visible !== null) staffFilter._id = { $in: visible };
  let staff = await users.find(staffFilter).sort({ name: 1 }).toArray();
  if (query.exec) staff = staff.filter((s) => s._id === query.exec);
  const ids = staff.map((s) => s._id);

  const filename = `trendzo-${query.type}-${from}-to-${to}.csv`;
  const rows =
    query.type === 'conversion'
      ? await conversionRows(ids)
      : query.type === 'followups'
        ? await followupRows(ids, from, to, today)
        : await performanceRows(staff, ids, from, to, query.type === 'daily');

  return { rows, from, to, filename };
}

async function performanceRows(
  staff: { _id: string; name: string }[],
  ids: string[],
  from: string,
  to: string,
  daily: boolean,
): Promise<Row[]> {
  const [visitsCol, checklistCol, followupsCol] = await Promise.all([
    crm.visits(),
    crm.checklist(),
    crm.followups(),
  ]);

  const TRACKED: CrmStepKey[] = [
    'demo_given',
    'interested',
    'agreement_signed',
    'signup_completed',
    'onboarding_completed',
  ];

  const [visitAgg, activeDayAgg, stepAgg, followupAgg, targets] = await Promise.all([
    visitsCol
      .aggregate<{ _id: string; n: number }>([
        { $match: { userId: { $in: ids }, date: { $gte: from, $lte: to } } },
        { $group: { _id: '$userId', n: { $sum: 1 } } },
      ])
      .toArray(),
    visitsCol
      .aggregate<{ _id: string; days: string[] }>([
        { $match: { userId: { $in: ids }, date: { $gte: from, $lte: to } } },
        { $group: { _id: '$userId', days: { $addToSet: '$date' } } },
      ])
      .toArray(),
    checklistCol
      .aggregate<{ _id: { user: string; step: CrmStepKey }; n: number }>([
        {
          $match: {
            done: true,
            doneBy: { $in: ids },
            stepKey: { $in: TRACKED },
            doneDate: { $gte: from, $lte: to },
          },
        },
        { $group: { _id: { user: '$doneBy', step: '$stepKey' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    followupsCol
      .aggregate<{ _id: string; n: number }>([
        {
          $match: {
            userId: { $in: ids },
            createdAt: { $gte: `${from}T00:00:00.000Z`, $lte: `${to}T23:59:59.999Z` },
          },
        },
        { $group: { _id: '$userId', n: { $sum: 1 } } },
      ])
      .toArray(),
    getTargetsFor(ids),
  ]);

  const visitsOf = new Map(visitAgg.map((v) => [v._id, v.n]));
  const activeDaysOf = new Map(activeDayAgg.map((v) => [v._id, v.days.length]));
  const followupsOf = new Map(followupAgg.map((v) => [v._id, v.n]));
  const stepOf = new Map<string, Map<CrmStepKey, number>>();
  for (const id of ids) stepOf.set(id, new Map());
  for (const r of stepAgg) stepOf.get(r._id.user)?.set(r._id.step, r.n);

  const days = crmDaySpan(from, to);

  return staff.map((s) => {
    const step = (k: CrmStepKey) => stepOf.get(s._id)?.get(k) ?? 0;
    const visits = visitsOf.get(s._id) ?? 0;
    const activeDays = activeDaysOf.get(s._id) ?? 0;
    const onboarded = step('onboarding_completed');
    const targetVisits = (targets.get(s._id)?.visits ?? 0) * days;
    const base: Row = {
      Salesperson: s.name,
      Visits: visits,
      Demos: step('demo_given'),
      Interested: step('interested'),
      Agreements: step('agreement_signed'),
      Signups: step('signup_completed'),
      Onboarded: onboarded,
      'Conversion %': crmPct(onboarded, visits),
    };
    if (daily) {
      base['Follow-ups Created'] = followupsOf.get(s._id) ?? 0;
      base['Visit Target'] = targetVisits;
      base['Achievement %'] = crmPct(visits, targetVisits);
    } else {
      base['Avg Visits / Day'] =
        activeDays > 0 ? Math.round((visits / activeDays) * 10) / 10 : 0;
      base['Target Achievement %'] = crmPct(visits, targetVisits);
    }
    return base;
  });
}

async function conversionRows(ids: string[]): Promise<Row[]> {
  const [retailersCol, checklistCol, usersCol] = await Promise.all([
    crm.retailers(),
    crm.checklist(),
    crm.users(),
  ]);
  const leads = await retailersCol
    .find({ assignedTo: { $in: ids } })
    .sort({ createdAt: -1 })
    .limit(5000)
    .toArray();
  if (leads.length === 0) return [];

  const leadIds = leads.map((l) => l._id);
  const steps = await checklistCol
    .find(
      { retailerId: { $in: leadIds }, done: true },
      { projection: { retailerId: 1, stepKey: 1, doneDate: 1 } },
    )
    .toArray();
  const stepOf = new Map<string, Map<string, string>>();
  for (const s of steps) {
    if (!stepOf.has(s.retailerId)) stepOf.set(s.retailerId, new Map());
    if (s.doneDate) stepOf.get(s.retailerId)!.set(s.stepKey, s.doneDate);
  }
  const staff = await usersCol.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
  const nameOf = new Map(staff.map((s) => [s._id, s.name]));
  const today = crmLocalDay();

  return leads.map((l) => {
    const at = (k: string) => stepOf.get(l._id)?.get(k) ?? '';
    const onboardedOn = at('onboarding_completed');
    // Days a lead has been in play: creation → onboarding, or → today if still open.
    const daysIn = Math.max(
      0,
      Math.round(
        (Date.parse(`${onboardedOn || today}T00:00:00Z`) - Date.parse(l.createdAt)) / 86_400_000,
      ),
    );
    return {
      Retailer: l.storeName,
      Owner: l.ownerName ?? '',
      Phone: l.mobile ?? '',
      Area: l.area ?? '',
      Salesperson: l.assignedTo ? (nameOf.get(l.assignedTo) ?? '') : '',
      Status: CRM_STATUS_LABEL[l.status as CrmStatus] ?? l.status,
      Created: l.createdAt.slice(0, 10),
      'First Visit': at('store_visited'),
      'Demo On': at('demo_given'),
      'Agreement On': at('agreement_signed'),
      'Signup On': at('signup_completed'),
      'Onboarded On': onboardedOn,
      'Days in Pipeline': daysIn,
    };
  });
}

async function followupRows(
  ids: string[],
  from: string,
  to: string,
  today: string,
): Promise<Row[]> {
  const [followupsCol, retailersCol, usersCol] = await Promise.all([
    crm.followups(),
    crm.retailers(),
    crm.users(),
  ]);
  const rows = await followupsCol
    .find({ userId: { $in: ids }, date: { $gte: from, $lte: to } })
    .sort({ date: 1, time: 1 })
    .limit(5000)
    .toArray();
  if (rows.length === 0) return [];

  const [leads, staff] = await Promise.all([
    retailersCol
      .find(
        { _id: { $in: [...new Set(rows.map((r) => r.retailerId))] } },
        { projection: { storeName: 1, area: 1 } },
      )
      .toArray(),
    usersCol.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray(),
  ]);
  const leadOf = new Map(leads.map((l) => [l._id, l]));
  const nameOf = new Map(staff.map((s) => [s._id, s.name]));

  return rows.map((f) => ({
    Retailer: leadOf.get(f.retailerId)?.storeName ?? '',
    Area: leadOf.get(f.retailerId)?.area ?? '',
    Salesperson: nameOf.get(f.userId) ?? '',
    'Due Date': f.date,
    Time: f.time ?? '',
    Type: f.type,
    Reason: f.reason ?? '',
    Status:
      f.status === 'pending'
        ? f.date < today
          ? 'Overdue'
          : 'Pending'
        : f.status === 'done'
          ? 'Done'
          : 'Cancelled',
    Created: f.createdAt.slice(0, 10),
  }));
}

/** JSON variant used by the on-screen report preview. */
export async function reportJson(input: {
  actor: CrmActor;
  query: z.infer<typeof ReportQuery>;
}) {
  const { rows, from, to } = await buildReport(input);
  return ok({ rows, range: { from, to } });
}
