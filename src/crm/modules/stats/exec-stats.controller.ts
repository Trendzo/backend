import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import {
  crmDayOfMonth,
  crmDayRange,
  crmLocalDay,
  crmMonthStart,
  crmPct,
  type CrmStepKey,
} from '../../domain.js';
import { getTargets, userNames, type CrmActor } from '../../store.js';
import { shapeFollowup } from '../../shape.js';

/**
 * Home-screen analytics for one salesperson: today against target, the follow-up queue,
 * month-to-date performance, a seven-day visit trend, and the derived notifications.
 *
 * Everything buckets on the CRM's local calendar day (see `crmLocalDay`) so a rep's "today"
 * is their working day, not a UTC window that rolls over mid-evening.
 */

/** Count checklist steps of one kind ticked by one user inside a local-day range. */
async function stepCount(
  userId: string,
  step: CrmStepKey,
  from: string,
  to: string,
): Promise<number> {
  const checklist = await crm.checklist();
  return checklist.countDocuments({
    done: true,
    doneBy: userId,
    stepKey: step,
    doneDate: { $gte: from, $lte: to },
  });
}

export async function execStats(input: { actor: CrmActor }) {
  const { actor } = input;
  if (actor.kind !== 'sales') {
    // An admin has no personal field book; the admin dashboard is the equivalent view.
    return ok({
      today: {
        target: 0,
        visits: 0,
        demos: 0,
        agreements: 0,
        onboarded: 0,
        interested: 0,
        followupsCreated: 0,
      },
      followupsToday: [],
      followupsOverdue: [],
      recent: [],
      month: {
        visits: 0,
        demos: 0,
        interested: 0,
        agreements: 0,
        signups: 0,
        onboarded: 0,
        conversion: 0,
        avgPerDay: 0,
        achievement: 0,
      },
      notifications: [],
      week: [],
      targets: await getTargets('__none__'),
    });
  }

  const uid = actor.id;
  const today = crmLocalDay();
  const monthStart = crmMonthStart();
  const targets = await getTargets(uid);

  const [visitsCol, followupsCol, retailersCol] = await Promise.all([
    crm.visits(),
    crm.followups(),
    crm.retailers(),
  ]);

  const [
    visitsToday,
    demosToday,
    agreementsToday,
    onboardedToday,
    interestedToday,
    followupsCreatedToday,
  ] = await Promise.all([
    visitsCol.countDocuments({ userId: uid, date: today }),
    stepCount(uid, 'demo_given', today, today),
    stepCount(uid, 'agreement_signed', today, today),
    stepCount(uid, 'onboarding_completed', today, today),
    stepCount(uid, 'interested', today, today),
    followupsCol.countDocuments({
      userId: uid,
      createdAt: { $gte: `${today}T00:00:00.000Z`, $lte: `${today}T23:59:59.999Z` },
    }),
  ]);

  // ── Follow-up queue ────────────────────────────────────────────────────────
  const [dueToday, overdue] = await Promise.all([
    followupsCol
      .find({ userId: uid, status: 'pending', date: today })
      .sort({ time: 1 })
      .limit(20)
      .toArray(),
    followupsCol
      .find({ userId: uid, status: 'pending', date: { $lt: today } })
      .sort({ date: 1 })
      .limit(20)
      .toArray(),
  ]);
  const queueLeadIds = [...new Set([...dueToday, ...overdue].map((f) => f.retailerId))];
  const queueLeads = await retailersCol
    .find({ _id: { $in: queueLeadIds } }, { projection: { storeName: 1, area: 1, status: 1 } })
    .toArray();
  const leadOf = new Map(queueLeads.map((l) => [l._id, l]));
  const decorate = (f: (typeof dueToday)[number]) => ({
    ...shapeFollowup(f, { userName: actor.name }),
    store_name: leadOf.get(f.retailerId)?.storeName ?? null,
    area: leadOf.get(f.retailerId)?.area ?? null,
    retailer_status: leadOf.get(f.retailerId)?.status ?? null,
  });

  // ── Recently worked leads ──────────────────────────────────────────────────
  const recentRows = await retailersCol
    .find({ assignedTo: uid })
    .sort({ updatedAt: -1 })
    .limit(6)
    .toArray();
  const recentIds = recentRows.map((r) => r._id);
  const [recentVisits, recentFollowups] = await Promise.all([
    visitsCol
      .aggregate<{ _id: string; lastVisit: string | null }>([
        { $match: { retailerId: { $in: recentIds } } },
        { $group: { _id: '$retailerId', lastVisit: { $max: '$checkInAt' } } },
      ])
      .toArray(),
    followupsCol
      .find(
        { retailerId: { $in: recentIds }, status: 'pending' },
        { projection: { retailerId: 1, date: 1, time: 1 }, sort: { date: 1, time: 1 } },
      )
      .toArray(),
  ]);
  const lastVisitOf = new Map(recentVisits.map((v) => [v._id, v.lastVisit]));
  const nextFuOf = new Map<string, { date: string; time: string | null }>();
  for (const f of recentFollowups) {
    if (!nextFuOf.has(f.retailerId)) nextFuOf.set(f.retailerId, { date: f.date, time: f.time });
  }
  const recent = recentRows.map((r) => ({
    id: r._id,
    store_name: r.storeName,
    area: r.area,
    status: r.status,
    last_visit: lastVisitOf.get(r._id) ?? null,
    next_fu_date: nextFuOf.get(r._id)?.date ?? null,
    next_fu_time: nextFuOf.get(r._id)?.time ?? null,
  }));

  // ── Month to date ──────────────────────────────────────────────────────────
  const [visitsMonth, activeDaysAgg, demosMonth, interestedMonth, agreementsMonth, signupsMonth, onboardedMonth] =
    await Promise.all([
      visitsCol.countDocuments({ userId: uid, date: { $gte: monthStart, $lte: today } }),
      visitsCol.distinct('date', { userId: uid, date: { $gte: monthStart, $lte: today } }),
      stepCount(uid, 'demo_given', monthStart, today),
      stepCount(uid, 'interested', monthStart, today),
      stepCount(uid, 'agreement_signed', monthStart, today),
      stepCount(uid, 'signup_completed', monthStart, today),
      stepCount(uid, 'onboarding_completed', monthStart, today),
    ]);
  const activeDays = activeDaysAgg.length;
  const daysElapsed = crmDayOfMonth();
  const month = {
    visits: visitsMonth,
    demos: demosMonth,
    interested: interestedMonth,
    agreements: agreementsMonth,
    signups: signupsMonth,
    onboarded: onboardedMonth,
    conversion: crmPct(onboardedMonth, visitsMonth),
    // Averaged over days actually worked, not calendar days — a rep on leave shouldn't
    // see their average collapse.
    avgPerDay: activeDays > 0 ? Math.round((visitsMonth / activeDays) * 10) / 10 : 0,
    achievement: crmPct(visitsMonth, targets.visits * daysElapsed),
  };

  // ── Seven-day trend ────────────────────────────────────────────────────────
  const weekDays = crmDayRange(shiftDays(today, -6), today);
  const weekCounts = await visitsCol
    .aggregate<{ _id: string; n: number }>([
      { $match: { userId: uid, date: { $gte: weekDays[0] ?? today, $lte: today } } },
      { $group: { _id: '$date', n: { $sum: 1 } } },
    ])
    .toArray();
  const weekOf = new Map(weekCounts.map((w) => [w._id, w.n]));
  const week = weekDays.map((d) => ({ label: d.slice(8), value: weekOf.get(d) ?? 0 }));

  // ── Derived notifications ──────────────────────────────────────────────────
  const staleCutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const stale = await retailersCol
    .find(
      {
        assignedTo: uid,
        status: { $in: ['agreement_pending', 'signup_pending'] },
        updatedAt: { $lt: staleCutoff },
      },
      { projection: { storeName: 1 } },
    )
    .limit(3)
    .toArray();

  const notifications: { text: string; kind: 'warn' | 'info' }[] = [];
  if (overdue.length > 0) {
    notifications.push({
      text: `${overdue.length} follow-up${overdue.length > 1 ? 's are' : ' is'} overdue.`,
      kind: 'warn',
    });
  }
  if (dueToday.length > 0) {
    notifications.push({
      text: `${dueToday.length} follow-up${dueToday.length > 1 ? 's are' : ' is'} due today.`,
      kind: 'info',
    });
  }
  notifications.push({
    text: `You have completed ${visitsToday} of ${targets.visits} visits today.`,
    kind: 'info',
  });
  for (const s of stale) {
    notifications.push({ text: `${s.storeName} has been pending for over 3 days.`, kind: 'warn' });
  }

  return ok({
    today: {
      target: targets.visits,
      visits: visitsToday,
      demos: demosToday,
      agreements: agreementsToday,
      onboarded: onboardedToday,
      interested: interestedToday,
      followupsCreated: followupsCreatedToday,
    },
    followupsToday: dueToday.map(decorate),
    followupsOverdue: overdue.map(decorate),
    recent,
    month,
    notifications,
    week,
    targets,
  });
}

/** Shift a YYYY-MM-DD string by N days (negative = earlier). */
function shiftDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Distinct areas/cities present in the book — powers the filter dropdowns. */
export async function filterOptions(input: { actor: CrmActor }) {
  const retailers = await crm.retailers();
  const [areas, cities, users] = await Promise.all([
    retailers.distinct('area', { area: { $ne: null } }),
    retailers.distinct('city', { city: { $ne: null } }),
    crm.users(),
  ]);
  const execs = await users
    .find({ active: true, role: { $in: ['exec', 'manager'] } }, { projection: { name: 1 } })
    .sort({ name: 1 })
    .toArray();
  void input;
  const names = await userNames(execs.map((e) => e._id));
  return ok({
    areas: (areas as string[]).filter(Boolean).sort(),
    cities: (cities as string[]).filter(Boolean).sort(),
    execs: execs.map((e) => ({ id: e._id, name: names.get(e._id) ?? e.name })),
  });
}
