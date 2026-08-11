import type { z } from 'zod';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { crm } from '../../db/client.js';
import {
  CRM_OUTCOME_LABEL,
  CRM_POSITIVE_OUTCOMES,
  CRM_STEP_LABEL,
  crmLocalDay,
  type CrmStepKey,
} from '../../domain.js';
import {
  assertCanSeeRetailer,
  CrmIdPrefix,
  crmId,
  ensureTodayVisit,
  getRetailerOr404,
  logActivity,
  nowIso,
  recalcStatus,
  touchRetailer,
  visibleUserIds,
  type CrmActor,
} from '../../store.js';
import type { ActionBody } from './retailers.validators.js';

/**
 * The CRM's single mutation endpoint.
 *
 * Every field action a rep can take routes through here so that (a) the derived status is
 * recomputed in exactly one place and can never drift from the underlying facts, and (b) every
 * change lands in the append-only activity log. Adding a new action means adding a case here,
 * not a new endpoint with its own half-remembered bookkeeping.
 */

/** Actions a platform admin performs need a CRM user to attribute the work to. */
function actingUserId(actor: CrmActor, retailerAssignee: string | null): string {
  if (actor.kind === 'sales') return actor.id;
  // An admin working a lead attributes visits/steps to the assigned rep — the field work is
  // theirs, and per-rep stats would otherwise develop holes. The activity log still records
  // the admin as the actor, so the audit trail stays honest about who clicked.
  if (retailerAssignee) return retailerAssignee;
  throw new AppError(
    400,
    ErrorCode.ValidationError,
    'Assign this retailer to a salesperson before recording field activity',
  );
}

export async function runAction(input: {
  actor: CrmActor;
  id: string;
  body: z.infer<typeof ActionBody>;
}) {
  const { actor, id, body } = input;
  const retailer = await getRetailerOr404(id);
  await assertCanSeeRetailer(actor, retailer);

  const retailers = await crm.retailers();

  switch (body.type) {
    case 'checklist': {
      const step = body.step as CrmStepKey;
      const userId = actingUserId(actor, retailer.assignedTo);
      const checklist = await crm.checklist();
      if (body.done) {
        const at = nowIso();
        await checklist.updateOne(
          { retailerId: id, stepKey: step },
          {
            $set: { done: true, doneBy: userId, doneAt: at, doneDate: crmLocalDay() },
            $setOnInsert: { _id: crmId(CrmIdPrefix.Checklist), retailerId: id, stepKey: step },
          },
          { upsert: true },
        );
        // Progress implies presence — make sure today's visit is on the books even if the
        // rep forgot to check in, otherwise the day's visit count under-reports real work.
        await ensureTodayVisit(id, userId);
        // New progress re-opens a lead that had been written off.
        if (retailer.notInterested) {
          await retailers.updateOne(
            { _id: id },
            { $set: { notInterested: false, notInterestedReason: null } },
          );
        }
        await logActivity({ retailerId: id, actor, type: 'step_done', detail: CRM_STEP_LABEL[step] });
      } else {
        await checklist.updateOne(
          { retailerId: id, stepKey: step },
          { $set: { done: false, doneAt: null, doneDate: null } },
        );
        await logActivity({
          retailerId: id,
          actor,
          type: 'step_undone',
          detail: `Unmarked: ${CRM_STEP_LABEL[step]}`,
        });
      }
      break;
    }

    case 'checkin': {
      const userId = actingUserId(actor, retailer.assignedTo);
      await ensureTodayVisit(id, userId, { lat: body.lat ?? null, lng: body.lng ?? null });
      await logActivity({ retailerId: id, actor, type: 'checkin', detail: 'Checked in at store' });
      break;
    }

    case 'checkout': {
      const userId = actingUserId(actor, retailer.assignedTo);
      const visits = await crm.visits();
      // Scoped to this user: two reps at the same store each close their own visit.
      const open = await visits.findOne(
        { retailerId: id, userId, checkOutAt: null, checkInAt: { $ne: null } },
        { sort: { createdAt: -1 } },
      );
      if (!open) {
        throw new AppError(
          400,
          ErrorCode.InvalidState,
          'No open check-in for this store',
        );
      }
      await visits.updateOne({ _id: open._id }, { $set: { checkOutAt: nowIso() } });
      await logActivity({ retailerId: id, actor, type: 'checkout', detail: 'Checked out' });
      break;
    }

    case 'outcome': {
      const outcome = body.outcome;
      const label = CRM_OUTCOME_LABEL[outcome];
      if (!label) throw new AppError(400, ErrorCode.ValidationError, 'Choose a visit outcome');
      const reason = body.reason ?? null;
      if (outcome === 'not_interested' && !reason) {
        throw new AppError(
          400,
          ErrorCode.ValidationError,
          'Select a reason for Not Interested',
        );
      }
      const userId = actingUserId(actor, retailer.assignedTo);
      const visitId = await ensureTodayVisit(id, userId);
      const visits = await crm.visits();
      await visits.updateOne({ _id: visitId }, { $set: { outcome, outcomeReason: reason } });

      if (outcome === 'not_interested') {
        await retailers.updateOne(
          { _id: id },
          { $set: { notInterested: true, notInterestedReason: reason } },
        );
      } else if (CRM_POSITIVE_OUTCOMES.has(outcome) && retailer.notInterested) {
        await retailers.updateOne(
          { _id: id },
          { $set: { notInterested: false, notInterestedReason: null } },
        );
      }
      await logActivity({
        retailerId: id,
        actor,
        type: 'outcome_set',
        detail: `Visit outcome: ${label}${reason ? ` (${reason})` : ''}`,
      });
      break;
    }

    case 'note': {
      const notes = await crm.notes();
      await notes.insertOne({
        _id: crmId(CrmIdPrefix.Note),
        retailerId: id,
        userId: actingUserId(actor, retailer.assignedTo),
        text: body.text,
        at: nowIso(),
      });
      await logActivity({ retailerId: id, actor, type: 'note_added', detail: 'Note added' });
      break;
    }

    case 'followup': {
      const followups = await crm.followups();
      const userId = actingUserId(actor, retailer.assignedTo);
      await followups.insertOne({
        _id: crmId(CrmIdPrefix.Followup),
        retailerId: id,
        userId,
        date: body.date,
        time: body.time ?? null,
        type: body.ftype,
        reason: body.reason ?? null,
        notes: body.notes ?? null,
        status: 'pending',
        createdAt: nowIso(),
        completedAt: null,
      });
      await logActivity({
        retailerId: id,
        actor,
        type: 'followup_scheduled',
        detail: `${body.ftype} follow-up scheduled for ${body.date}${body.time ? ` ${body.time}` : ''}`,
      });
      break;
    }

    case 'followup_done':
    case 'followup_cancel': {
      const followups = await crm.followups();
      const fu = await followups.findOne({ _id: body.followup_id, retailerId: id });
      if (!fu) throw new AppError(404, ErrorCode.NotFound, 'Follow-up not found');
      if (fu.status !== 'pending') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `That follow-up is already ${fu.status}`,
        );
      }
      const done = body.type === 'followup_done';
      await followups.updateOne(
        { _id: fu._id },
        { $set: { status: done ? 'done' : 'cancelled', completedAt: nowIso() } },
      );
      await logActivity({
        retailerId: id,
        actor,
        type: done ? 'followup_completed' : 'followup_cancelled',
        detail: `${fu.type} follow-up ${done ? 'completed' : 'cancelled'}`,
      });
      break;
    }

    case 'assign': {
      // Reassignment is a management action: reps work their own book, they don't hand it
      // around. Managers may move leads inside their team; admins anywhere.
      if (actor.kind === 'sales' && actor.role !== 'manager') {
        throw new AppError(403, ErrorCode.Forbidden, 'Only a manager or admin can reassign');
      }
      const users = await crm.users();
      const target = await users.findOne({ _id: body.user_id, active: true });
      if (!target) throw new AppError(404, ErrorCode.NotFound, 'Salesperson not found');
      if (actor.kind === 'sales') {
        const visible = await visibleUserIds(actor);
        if (visible && !visible.includes(body.user_id)) {
          throw new AppError(403, ErrorCode.Forbidden, 'That salesperson is not on your team');
        }
      }
      if (target._id === retailer.assignedTo) {
        // No-op reassignment — don't pollute the history with a self-transfer.
        break;
      }
      const at = nowIso();
      const assignments = await crm.assignments();
      await assignments.insertOne({
        _id: crmId(CrmIdPrefix.Assignment),
        retailerId: id,
        fromUser: retailer.assignedTo,
        toUser: target._id,
        changedBy: actor.kind === 'sales' ? actor.id : null,
        at,
      });
      await retailers.updateOne({ _id: id }, { $set: { assignedTo: target._id, updatedAt: at } });
      await logActivity({
        retailerId: id,
        actor,
        type: 'assigned',
        detail: `Assigned to ${target.name}`,
        at,
      });
      break;
    }
  }

  await touchRetailer(id);
  const status = await recalcStatus(id, actor);
  return ok({ ok: true, status });
}
