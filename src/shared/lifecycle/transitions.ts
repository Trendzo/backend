/**
 * THE single source of truth for store + retailer-account lifecycle transitions.
 *
 * History: lifecycle used to be encoded in TWO fields — the status enum AND a
 * `permanent_suspend` boolean — written by seven different controllers, each with its
 * own hand-rolled guard. The two fields drifted (reinstate checked `status`, button
 * visibility checked the boolean; reject/policy/staff paths set `terminated` without
 * the boolean, making those accounts un-reinstatable). The boolean is now GONE from
 * the schema; `status` is the only truth, and every suspend / terminate / reinstate /
 * pause / close / reopen transition flows through here. (Staff activate/deactivate and
 * onboarding approval write their simple status flips directly.)
 *
 * Design: pure functions. Given the current status and an action they return the
 * exact `.set()` patch (or throw a 409 AppError naming the illegal move). Callers
 * apply the patch with their own executor (db or tx) and keep their own audit/notify.
 *
 * Every patch fully normalizes the state-attribute columns for the TARGET state:
 *   → active                : suspend* cleared, pause* cleared
 *   → paused                : pause* set,       suspend* cleared
 *   → suspended/terminated  : suspend* set,     pause* cleared
 * The pause* clearing on suspend/terminate is load-bearing: the
 * `retailer_stores_pause_guard` CHECK requires pause fields to be NULL whenever
 * status != 'paused', so suspending a paused store without clearing them is a DB error.
 */
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

export type StoreStatus = 'onboarding' | 'active' | 'paused' | 'suspended' | 'terminated';
export type AccountStatus = 'pending_approval' | 'active' | 'terminated' | 'closed';

export type StoreAction =
  | 'activate' //  onboarding → active               (go-live)
  | 'pause' //     active → paused                   (soft, self-service or admin)
  | 'resume' //    paused → active
  | 'suspend' //   onboarding|active|paused → suspended  (admin block, reversible)
  | 'unsuspend' // suspended → active
  | 'terminate' // anything-but-terminated → terminated  (end the relationship)
  | 'reinstate'; // terminated|suspended → active

export type AccountAction =
  | 'terminate' // pending_approval|active|closed → terminated
  | 'reinstate' // terminated → active
  | 'close' //     active → closed                   (owner-requested, reversible)
  | 'reopen'; //   closed → active

const STORE_SOURCES: Record<StoreAction, readonly StoreStatus[]> = {
  activate: ['onboarding'],
  pause: ['active'],
  resume: ['paused'],
  suspend: ['onboarding', 'active', 'paused'],
  unsuspend: ['suspended'],
  terminate: ['onboarding', 'active', 'paused', 'suspended'],
  reinstate: ['terminated', 'suspended'],
};

const ACCOUNT_SOURCES: Record<AccountAction, readonly AccountStatus[]> = {
  terminate: ['pending_approval', 'active', 'closed'],
  reinstate: ['terminated'],
  close: ['active'],
  reopen: ['closed'],
};

const STORE_TARGETS: Record<StoreAction, StoreStatus> = {
  activate: 'active',
  pause: 'paused',
  resume: 'active',
  suspend: 'suspended',
  unsuspend: 'active',
  terminate: 'terminated',
  reinstate: 'active',
};

const ACCOUNT_TARGETS: Record<AccountAction, AccountStatus> = {
  terminate: 'terminated',
  reinstate: 'active',
  close: 'closed',
  reopen: 'active',
};

function illegal(entity: 'store' | 'account', action: string, current: string): never {
  throw new AppError(
    409,
    ErrorCode.InvalidState,
    `Cannot ${action} a ${entity} in '${current}' status`,
  );
}

const CLEAR_SUSPEND = {
  suspendReason: null as string | null,
  suspendedAt: null as Date | null,
  suspendedByAccountId: null as string | null,
};

const CLEAR_PAUSE = {
  pauseReason: null as string | null,
  pauseVisibility: null as 'visible' | 'hidden' | null,
  pauseUntil: null as Date | null,
};

export type SuspendOpts = { reason?: string | null; actorId?: string | null };
export type PauseOpts = {
  reason?: string | null;
  visibility?: 'visible' | 'hidden';
  until?: Date | null;
};

/**
 * Compute the `.set()` patch for a STORE transition, or throw 409 on an illegal move.
 * `opts.reason`/`opts.actorId` populate the suspend attribution on suspend/terminate;
 * `pause` uses the PauseOpts overload fields.
 */
export function storeTransition(
  current: string,
  action: StoreAction,
  opts: SuspendOpts & PauseOpts = {},
): Record<string, unknown> {
  if (!STORE_SOURCES[action].includes(current as StoreStatus)) {
    illegal('store', action, current);
  }
  const status = STORE_TARGETS[action];
  switch (action) {
    case 'pause':
      return {
        status,
        pauseReason: opts.reason ?? null,
        pauseVisibility: opts.visibility ?? 'visible',
        pauseUntil: opts.until ?? null,
        ...CLEAR_SUSPEND,
      };
    case 'suspend':
    case 'terminate':
      return {
        status,
        suspendReason: opts.reason ?? null,
        suspendedAt: new Date(),
        suspendedByAccountId: opts.actorId ?? null,
        ...CLEAR_PAUSE,
      };
    // activate / resume / unsuspend / reinstate all land on a clean 'active'.
    default:
      return { status, ...CLEAR_SUSPEND, ...CLEAR_PAUSE };
  }
}

/** Compute the `.set()` patch for a retailer-ACCOUNT transition, or throw 409. */
export function accountTransition(
  current: string,
  action: AccountAction,
  opts: SuspendOpts = {},
): Record<string, unknown> {
  if (!ACCOUNT_SOURCES[action].includes(current as AccountStatus)) {
    illegal('account', action, current);
  }
  const status = ACCOUNT_TARGETS[action];
  switch (action) {
    case 'terminate':
    case 'close':
      return {
        status,
        suspendReason: opts.reason ?? null,
        suspendedAt: new Date(),
        suspendedByAccountId: opts.actorId ?? null,
      };
    // reinstate / reopen land on a clean 'active'.
    default:
      return { status, ...CLEAR_SUSPEND };
  }
}

// NOTE: consumer-facing predicates derived from these states live at their point of
// use — order intake is `store.status === 'active'` (compute-quote) and catalog
// visibility is the `storeIsBrowsableSql` EXISTS clause (catalog controller, where it
// must be raw SQL). Deliberately NOT duplicated here as unused helpers.
