import { z } from 'zod';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import type { CrmUser } from '../../db/types.js';
import {
  CRM_STATUS_ORDER,
  crmDayRange,
  crmDaySpan,
  crmLocalDay,
  crmPct,
  type CrmStepKey,
} from '../../domain.js';
import { getTargetsFor, visibleUserIds, type CrmActor } from '../../store.js';

/**
 * Manager/admin dashboard for the CRM.
 *
 * One request feeds the whole screen: KPI band, conversion funnel, per-person leaderboard,
 * the 14-day visit trend, target-vs-completed bars, status distribution, recent activity and
 * the pending follow-up queue — plus the filter option lists so the page never needs a second
 * round trip to populate its dropdowns.
 *
 * Counting rule: field work is attributed to the salesperson who did it (`visits.userId`,
 * `checklist.doneBy`), so every metric here is per-rep regardless of who clicked in the UI.
 */

const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AdminStatsQuery = z.object({
  from: LocalDay.optional(),
  to: LocalDay.optional(),
  exec: z.string().trim().max(80).optional(),
  territory: z.string().trim().max(80).optional(),
});

/** Aggregate checklist ticks per step per user across a local-day range, in one query. */
async function stepCounts(
  userIds: string[],
  steps: CrmStepKey[],
  from: string,
  to: string,
): Promise<Map<string, Map<CrmStepKey, number>>> {
  const checklist = await crm.checklist();
  const rows = await checklist
    .aggregate<{ _id: { user: string; step: CrmStepKey }; n: number }>([
      {
        $match: {
          done: true,
          doneBy: { $in: userIds },
          stepKey: { $in: steps },
          doneDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: { user: '$doneBy', step: '$stepKey' }, n: { $sum: 1 } } },
    ])
    .toArray();

  const out = new Map<string, Map<CrmStepKey, number>>();
  for (const id of userIds) out.set(id, new Map());
  for (const r of rows) out.get(r._id.user)?.set(r._id.step, r.n);
  return out;
}

/** Total of one step across everyone in scope. */
function sumStep(
  counts: Map<string, Map<CrmStepKey, number>>,
  step: CrmStepKey,
): number {
  let total = 0;
  for (const perUser of counts.values()) total += perUser.get(step) ?? 0;
  return total;
}

export async function adminStats(input: {
  actor: CrmActor;
  query: z.infer<typeof AdminStatsQuery>;
}) {
  const { actor, query } = input;
  const today = crmLocalDay();
  const from = query.from ?? today;
  const to = query.to ?? today;

  const users = await crm.users();
  const allStaff = await users
    .find({ role: { $in: ['exec', 'manager'] }, active: true })
    .sort({ name: 1 })
    .toArray();

  // Scope first (a manager only ever sees their own team), then apply the UI filters.
  const visible = await visibleUserIds(actor);
  const inScope = visible === null ? allStaff : allStaff.filter((u) => visible.includes(u._id));
  let selected = inScope;
  if (query.territory) selected = selected.filter((u) => u.territoryId === query.territory);
  if (query.exec) selected = selected.filter((u) => u._id === query.exec);
  const ids = selected.map((u) => u._id);

  const [visitsCol, retailersCol, followupsCol, activityCol, territoriesCol] = await Promise.all([
    crm.visits(),
    crm.retailers(),
    crm.followups(),
    crm.activity(),
    crm.territories(),
  ]);

  const TRACKED: CrmStepKey[] = [
    'demo_given',
    'interested',
    'agreement_signed',
    'signup_completed',
    'onboarding_completed',
  ];

  const [counts, visitsInRange, visitsToday, retailerCount, pendingFollowupCount, targets] =
    await Promise.all([
      stepCounts(ids, TRACKED, from, to),
      visitsCol.countDocuments({ userId: { $in: ids }, date: { $gte: from, $lte: to } }),
      visitsCol.countDocuments({ userId: { $in: ids }, date: today }),
      retailersCol.countDocuments({ assignedTo: { $in: ids } }),
      followupsCol.countDocuments({ userId: { $in: ids }, status: 'pending' }),
      getTargetsFor(ids),
    ]);

  const days = crmDaySpan(from, to);
  const targetToday = ids.reduce((sum, id) => sum + (targets.get(id)?.visits ?? 0), 0);

  const funnel = [
    { label: 'Store Visits', value: visitsInRange },
    { label: 'Demo Given', value: sumStep(counts, 'demo_given') },
    { label: 'Interested', value: sumStep(counts, 'interested') },
    { label: 'Agreements', value: sumStep(counts, 'agreement_signed') },
    { label: 'Signups', value: sumStep(counts, 'signup_completed') },
    { label: 'Onboarded', value: sumStep(counts, 'onboarding_completed') },
  ];

  const kpis = {
    execs: selected.length,
    visitsToday,
    targetToday,
    retailers: retailerCount,
    demos: funnel[1]!.value,
    interested: funnel[2]!.value,
    agreements: funnel[3]!.value,
    onboarded: funnel[5]!.value,
    followupsPending: pendingFollowupCount,
    conversion: crmPct(funnel[5]!.value, funnel[0]!.value),
  };

  // ── Leaderboard ────────────────────────────────────────────────────────────
  const perUserVisits = await visitsCol
    .aggregate<{ _id: string; n: number }>([
      { $match: { userId: { $in: ids }, date: { $gte: from, $lte: to } } },
      { $group: { _id: '$userId', n: { $sum: 1 } } },
    ])
    .toArray();
  const visitsOf = new Map(perUserVisits.map((v) => [v._id, v.n]));
  const territories = await territoriesCol.find({}).sort({ city: 1, name: 1 }).toArray();
  const territoryName = new Map(territories.map((t) => [t._id, t.name]));

  const leaderboard = selected
    .map((u) => {
      const perUser = counts.get(u._id);
      const visits = visitsOf.get(u._id) ?? 0;
      const targetVisits = (targets.get(u._id)?.visits ?? 0) * days;
      return {
        id: u._id,
        name: u.name,
        territory: u.territoryId ? (territoryName.get(u.territoryId) ?? null) : null,
        visits,
        demos: perUser?.get('demo_given') ?? 0,
        agreements: perUser?.get('agreement_signed') ?? 0,
        onboarded: perUser?.get('onboarding_completed') ?? 0,
        target: crmPct(visits, targetVisits),
      };
    })
    .sort((a, b) => b.visits - a.visits);

  const byOnboarded = [...leaderboard].sort((a, b) => b.onboarded - a.onboarded || b.visits - a.visits);
  const highlights = {
    topPerformer: byOnboarded[0]?.name ?? null,
    mostVisits: leaderboard[0]?.name ?? null,
    mostConversions: [...leaderboard].sort((a, b) => b.agreements - a.agreements)[0]?.name ?? null,
    highestOnboarding: byOnboarded[0]?.name ?? null,
  };

  // ── 14-day trend ───────────────────────────────────────────────────────────
  const trendDays = crmDayRange(shiftDays(today, -13), today);
  const trendRows = await visitsCol
    .aggregate<{ _id: string; n: number }>([
      { $match: { userId: { $in: ids }, date: { $gte: trendDays[0] ?? today, $lte: today } } },
      { $group: { _id: '$date', n: { $sum: 1 } } },
    ])
    .toArray();
  const trendOf = new Map(trendRows.map((r) => [r._id, r.n]));
  const visitsByDay = trendDays.map((d) => ({
    label: `${d.slice(8)}/${d.slice(5, 7)}`,
    value: trendOf.get(d) ?? 0,
  }));

  const targetBars = leaderboard.map((l) => ({
    label: l.name,
    value: l.visits,
    target: (targets.get(l.id)?.visits ?? 0) * days,
  }));
  const onboardBars = byOnboarded.map((l) => ({
    label: l.name.split(' ')[0] ?? l.name,
    value: l.onboarded,
  }));

  // ── Status distribution ────────────────────────────────────────────────────
  const distRows = await retailersCol
    .aggregate<{ _id: string; n: number }>([
      { $match: { assignedTo: { $in: ids } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    .toArray();
  const distOf = new Map(distRows.map((r) => [r._id, r.n]));
  const statusDist = CRM_STATUS_ORDER.map((s) => ({ status: s, value: distOf.get(s) ?? 0 }));

  // ── Recent activity ────────────────────────────────────────────────────────
  // Admin-performed actions carry a null userId by design, so the feed matches on the
  // acting rep OR on a lead inside the scoped book — otherwise admin edits vanish.
  const scopedLeadIds = await retailersCol.distinct('_id', { assignedTo: { $in: ids } });
  const activityRows = await activityCol
    .find({ $or: [{ userId: { $in: ids } }, { retailerId: { $in: scopedLeadIds } }] })
    .sort({ at: -1 })
    .limit(18)
    .toArray();
  const activityLeads = await retailersCol
    .find(
      { _id: { $in: [...new Set(activityRows.map((a) => a.retailerId).filter(Boolean))] as string[] } },
      { projection: { storeName: 1 } },
    )
    .toArray();
  const activityLeadOf = new Map(activityLeads.map((l) => [l._id, l.storeName]));
  const recentActivity = activityRows.map((a) => ({
    type: a.type,
    detail: a.detail,
    at: a.at,
    user_name: a.actorName,
    store_name: a.retailerId ? (activityLeadOf.get(a.retailerId) ?? null) : null,
    retailer_id: a.retailerId,
  }));

  // ── Pending follow-up queue ────────────────────────────────────────────────
  const pendingRows = await followupsCol
    .find({ userId: { $in: ids }, status: 'pending' })
    .sort({ date: 1, time: 1 })
    .limit(12)
    .toArray();
  const pendingLeads = await retailersCol
    .find(
      { _id: { $in: [...new Set(pendingRows.map((f) => f.retailerId))] } },
      { projection: { storeName: 1, area: 1 } },
    )
    .toArray();
  const pendingLeadOf = new Map(pendingLeads.map((l) => [l._id, l]));
  const nameOf = new Map(selected.map((u) => [u._id, u.name]));
  const pendingFollowups = pendingRows.map((f) => ({
    id: f._id,
    retailer_id: f.retailerId,
    date: f.date,
    time: f.time,
    type: f.type,
    reason: f.reason,
    store_name: pendingLeadOf.get(f.retailerId)?.storeName ?? null,
    area: pendingLeadOf.get(f.retailerId)?.area ?? null,
    exec_name: nameOf.get(f.userId) ?? null,
    overdue: f.date < today ? 1 : 0,
  }));

  return ok({
    kpis,
    funnel,
    leaderboard,
    highlights,
    visitsByDay,
    targetBars,
    onboardBars,
    statusDist,
    recentActivity,
    pendingFollowups,
    // Filter options come from the UNFILTERED in-scope set so narrowing to one person
    // never empties the dropdown that would let you widen again.
    execs: inScope.map(shapeStaffOption(territoryName)),
    territories: territories.map((t) => ({ id: t._id, city: t.city, name: t.name })),
    range: { from, to, days },
  });
}

function shapeStaffOption(territoryName: Map<string, string>) {
  return (u: CrmUser) => ({
    id: u._id,
    name: u.name,
    territory_id: u.territoryId,
    territory: u.territoryId ? (territoryName.get(u.territoryId) ?? null) : null,
  });
}

function shiftDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
