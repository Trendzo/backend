import type { z } from 'zod';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import { CRM_DEFAULT_TARGETS, crmLocalDay, crmMonthStart } from '../../domain.js';
import {
  CrmIdPrefix,
  crmId,
  getUserOr404,
  logActivity,
  nowIso,
  visibleUserIds,
  type CrmActor,
} from '../../store.js';
import type {
  CreateTeamMemberBody,
  SetTargetsBody,
  UpdateTeamMemberBody,
} from './team.validators.js';

/**
 * Sales-team administration: the directory with live per-person numbers, adding a salesperson,
 * editing them, per-person target overrides, and access revocation.
 *
 * Scoping matters here as much as anywhere: a manager administers only their own reports. The
 * original SQLite build gated these on "is staff" alone, which let any manager edit any other
 * team's people; every mutation below re-checks visibility.
 */

/** Throw unless the actor may administer this specific user. */
async function assertCanManage(actor: CrmActor, userId: string): Promise<void> {
  if (actor.kind === 'admin') return;
  if (actor.role !== 'manager') {
    throw new AppError(403, ErrorCode.Forbidden, 'Only a manager or admin can manage the team');
  }
  if (userId === actor.id) {
    throw new AppError(403, ErrorCode.Forbidden, 'You cannot administer your own account');
  }
  const visible = await visibleUserIds(actor);
  if (visible && !visible.includes(userId)) {
    throw new AppError(403, ErrorCode.Forbidden, 'That salesperson is not on your team');
  }
}

export async function listTeam(input: { actor: CrmActor }) {
  const { actor } = input;
  const users = await crm.users();
  const visible = await visibleUserIds(actor);

  const filter: Record<string, unknown> = { role: { $in: ['exec', 'manager'] } };
  if (visible !== null) filter._id = { $in: visible };

  const rows = await users.find(filter).sort({ active: -1, name: 1 }).toArray();
  if (rows.length === 0) return ok({ team: [] });

  const ids = rows.map((r) => r._id);
  const today = crmLocalDay();
  const monthStart = crmMonthStart();

  const [visitsCol, checklistCol, retailersCol, targetsCol, territoriesCol] = await Promise.all([
    crm.visits(),
    crm.checklist(),
    crm.retailers(),
    crm.targets(),
    crm.territories(),
  ]);

  const [todayVisits, monthVisits, onboarded, leadCounts, targetRows, territories] =
    await Promise.all([
      visitsCol
        .aggregate<{ _id: string; n: number }>([
          { $match: { userId: { $in: ids }, date: today } },
          { $group: { _id: '$userId', n: { $sum: 1 } } },
        ])
        .toArray(),
      visitsCol
        .aggregate<{ _id: string; n: number }>([
          { $match: { userId: { $in: ids }, date: { $gte: monthStart, $lte: today } } },
          { $group: { _id: '$userId', n: { $sum: 1 } } },
        ])
        .toArray(),
      checklistCol
        .aggregate<{ _id: string; n: number }>([
          {
            $match: {
              done: true,
              doneBy: { $in: ids },
              stepKey: 'onboarding_completed',
              doneDate: { $gte: monthStart, $lte: today },
            },
          },
          { $group: { _id: '$doneBy', n: { $sum: 1 } } },
        ])
        .toArray(),
      retailersCol
        .aggregate<{ _id: string; n: number }>([
          { $match: { assignedTo: { $in: ids } } },
          { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
        ])
        .toArray(),
      targetsCol.find({ userId: { $in: ids } }).toArray(),
      territoriesCol.find({}).toArray(),
    ]);

  const num = (rowsIn: { _id: string; n: number }[]) => new Map(rowsIn.map((r) => [r._id, r.n]));
  const todayOf = num(todayVisits);
  const monthOf = num(monthVisits);
  const onboardedOf = num(onboarded);
  const leadsOf = num(leadCounts);
  const targetOf = new Map(targetRows.map((t) => [t.userId, t]));
  const territoryOf = new Map(territories.map((t) => [t._id, t]));
  const nameOf = new Map(rows.map((r) => [r._id, r.name]));

  return ok({
    team: rows.map((u) => ({
      id: u._id,
      name: u.name,
      mobile: u.phone,
      role: u.role,
      email: u.email,
      employee_id: u.employeeId,
      territory_id: u.territoryId,
      territory: u.territoryId ? (territoryOf.get(u.territoryId)?.name ?? null) : null,
      territory_city: u.territoryId ? (territoryOf.get(u.territoryId)?.city ?? null) : null,
      manager_name: u.managerId ? (nameOf.get(u.managerId) ?? null) : null,
      active: u.active ? 1 : 0,
      last_login_at: u.lastLoginAt,
      created_at: u.createdAt,
      visits_today: todayOf.get(u._id) ?? 0,
      visits_month: monthOf.get(u._id) ?? 0,
      onboarded_month: onboardedOf.get(u._id) ?? 0,
      retailers: leadsOf.get(u._id) ?? 0,
      custom_visit_target: targetOf.get(u._id)?.visits ?? null,
    })),
  });
}

export async function createTeamMember(input: {
  actor: CrmActor;
  body: z.infer<typeof CreateTeamMemberBody>;
}) {
  const { actor, body } = input;
  if (actor.kind === 'sales' && actor.role !== 'manager') {
    throw new AppError(403, ErrorCode.Forbidden, 'Only a manager or admin can add salespeople');
  }
  // Only a platform admin may mint another manager — a manager promoting peers would
  // silently widen their own blast radius.
  const role = body.role === 'manager' && actor.kind === 'admin' ? 'manager' : 'exec';

  const users = await crm.users();
  const clash = await users.findOne({ phone: body.mobile });
  if (clash) {
    throw new AppError(
      409,
      ErrorCode.ValidationError,
      'A salesperson with this mobile number already exists',
    );
  }

  const id = crmId(CrmIdPrefix.User);
  await users.insertOne({
    _id: id,
    name: body.name,
    phone: body.mobile,
    role,
    email: body.email ?? null,
    employeeId: body.employee_id ?? null,
    territoryId: body.territory_id ?? null,
    // A manager's new hire reports to them; an admin may name the manager explicitly.
    managerId: body.manager_id ?? (actor.kind === 'sales' ? actor.id : null),
    active: true,
    lastLoginAt: null,
    tokenVersion: 0,
    createdAt: nowIso(),
  });

  if (body.visit_target !== undefined) {
    const targets = await crm.targets();
    await targets.insertOne({
      _id: crmId(CrmIdPrefix.Target),
      userId: id,
      visits: body.visit_target,
      demos: body.demo_target ?? CRM_DEFAULT_TARGETS.demos,
      agreements: body.agreement_target ?? CRM_DEFAULT_TARGETS.agreements,
      onboardings: body.onboarding_target ?? CRM_DEFAULT_TARGETS.onboardings,
    });
  }

  await logActivity({
    retailerId: null,
    actor,
    type: 'user_added',
    detail: `Added salesperson ${body.name}`,
  });
  return ok({ id });
}

export async function updateTeamMember(input: {
  actor: CrmActor;
  id: string;
  body: z.infer<typeof UpdateTeamMemberBody>;
}) {
  const { actor, id, body } = input;
  const target = await getUserOr404(id);
  await assertCanManage(actor, id);

  const users = await crm.users();

  if ('action' in body) {
    if (body.action === 'reset_access') {
      // Stateless JWTs: bumping the version is what actually ends the live sessions.
      await users.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
      await logActivity({
        retailerId: null,
        actor,
        type: 'user_reset',
        detail: `Reset access for ${target.name}`,
      });
      return ok({ ok: true });
    }
    if (body.action === 'set_targets') {
      const targets = await crm.targets();
      await targets.updateOne(
        { userId: id },
        {
          $set: {
            visits: body.visits,
            demos: body.demos,
            agreements: body.agreements,
            onboardings: body.onboardings,
          },
          $setOnInsert: { _id: crmId(CrmIdPrefix.Target), userId: id },
        },
        { upsert: true },
      );
      await logActivity({
        retailerId: null,
        actor,
        type: 'targets_set',
        detail: `Updated targets for ${target.name}`,
      });
      return ok({ ok: true });
    }
    // clear_targets
    const targets = await crm.targets();
    await targets.deleteOne({ userId: id });
    await logActivity({
      retailerId: null,
      actor,
      type: 'targets_cleared',
      detail: `${target.name} reverted to global targets`,
    });
    return ok({ ok: true });
  }

  const set: Record<string, unknown> = {};
  if (body.name !== undefined) set.name = body.name;
  if (body.email !== undefined) set.email = body.email;
  if (body.employee_id !== undefined) set.employeeId = body.employee_id;
  if (body.territory_id !== undefined) set.territoryId = body.territory_id;
  if (body.manager_id !== undefined) set.managerId = body.manager_id;
  if (body.active !== undefined) set.active = body.active;
  if (body.role !== undefined) {
    if (actor.kind !== 'admin') {
      throw new AppError(403, ErrorCode.Forbidden, 'Only an admin can change a role');
    }
    set.role = body.role;
  }
  if (body.mobile !== undefined) {
    const clash = await users.findOne({ phone: body.mobile, _id: { $ne: id } });
    if (clash) {
      throw new AppError(
        409,
        ErrorCode.ValidationError,
        'Another salesperson already has this mobile number',
      );
    }
    set.phone = body.mobile;
  }
  if (Object.keys(set).length === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'Nothing to update');
  }

  // Deactivating, changing the sign-in phone, or changing the role must all invalidate
  // live tokens — otherwise the old session keeps the old privileges until it expires.
  const mustRevoke =
    body.active === false || body.mobile !== undefined || body.role !== undefined;
  await users.updateOne(
    { _id: id },
    mustRevoke ? { $set: set, $inc: { tokenVersion: 1 } } : { $set: set },
  );

  await logActivity({
    retailerId: null,
    actor,
    type: 'user_updated',
    detail:
      body.active === false
        ? `Deactivated ${target.name}`
        : body.active === true
          ? `Reactivated ${target.name}`
          : `Updated salesperson ${target.name}`,
  });
  return ok({ ok: true });
}

// ── Targets ──────────────────────────────────────────────────────────────────

export async function getTargetsOverview(input: { actor: CrmActor }) {
  const [targetsCol, users] = await Promise.all([crm.targets(), crm.users()]);
  const visible = await visibleUserIds(input.actor);

  const staffFilter: Record<string, unknown> = {
    role: { $in: ['exec', 'manager'] },
    active: true,
  };
  if (visible !== null) staffFilter._id = { $in: visible };
  const staff = await users.find(staffFilter).sort({ name: 1 }).toArray();
  const nameOf = new Map(staff.map((s) => [s._id, s.name]));

  const global = await targetsCol.findOne({ userId: null });
  const overrideRows = await targetsCol
    .find({ userId: { $in: staff.map((s) => s._id) } })
    .toArray();

  return ok({
    global: global
      ? {
          visits: global.visits,
          demos: global.demos,
          agreements: global.agreements,
          onboardings: global.onboardings,
        }
      : CRM_DEFAULT_TARGETS,
    overrides: overrideRows
      .map((t) => ({
        user_id: t.userId,
        name: t.userId ? (nameOf.get(t.userId) ?? null) : null,
        visits: t.visits,
        demos: t.demos,
        agreements: t.agreements,
        onboardings: t.onboardings,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    execs: staff.map((s) => ({ id: s._id, name: s.name })),
  });
}

export async function setTargets(input: {
  actor: CrmActor;
  body: z.infer<typeof SetTargetsBody>;
}) {
  const { actor, body } = input;
  const targets = await crm.targets();
  const values = {
    visits: body.visits,
    demos: body.demos,
    agreements: body.agreements,
    onboardings: body.onboardings,
  };

  if (body.user_id) {
    await assertCanManage(actor, body.user_id);
    const user = await getUserOr404(body.user_id);
    await targets.updateOne(
      { userId: body.user_id },
      { $set: values, $setOnInsert: { _id: crmId(CrmIdPrefix.Target), userId: body.user_id } },
      { upsert: true },
    );
    await logActivity({
      retailerId: null,
      actor,
      type: 'targets_set',
      detail: `Updated targets for ${user.name}`,
    });
  } else {
    // The global default is platform-wide policy, not a per-team lever.
    if (actor.kind !== 'admin') {
      throw new AppError(403, ErrorCode.Forbidden, 'Only an admin can change the global targets');
    }
    await targets.updateOne(
      { userId: null },
      { $set: values, $setOnInsert: { _id: crmId(CrmIdPrefix.Target), userId: null } },
      { upsert: true },
    );
    await logActivity({
      retailerId: null,
      actor,
      type: 'targets_set',
      detail: 'Updated global targets',
    });
  }
  return ok({ ok: true });
}
