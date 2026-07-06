/**
 * Sub-role permission catalog + runtime gate.
 *
 * Two scopes: `admin` (super_admin / ops_admin / support) and `retailer`
 * (owner / manager / staff). Action keys are dotted: `<resource>.<verb>`.
 *
 * The DB table `sub_role_permission_overrides` stores only deviations from
 * the defaults below. `requirePermission(action)` resolves effective
 * permission per request and throws `AppError.forbidden(...)` (HTTP 403)
 * when the caller's sub-role lacks the action.
 *
 * Staleness: sub-role lives in the JWT. After an admin's sub-role is
 * changed, their existing token still carries the prior sub-role until
 * they sign in again. Account-level status (`revoked`/`terminated`) is
 * enforced separately in `requireAuth`.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import type { InferSelectModel } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { subRolePermissionOverrides } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

// ───── Sub-role unions ────────────────────────────────────────────────────
export type AdminSubRole = 'super_admin' | 'ops_admin' | 'support';
export type RetailerSubRole = 'owner' | 'manager' | 'staff' | 'delivery_agent';

// ───── Action catalogs ────────────────────────────────────────────────────
// Listed explicitly so typos at call sites become TS errors.

export const ADMIN_ACTIONS = [
  // Team & sub-roles
  'team.list',
  'team.create',
  'team.update',
  'team.revoke',
  'team.reinstate',
  'team.reset_password',
  'sub_roles.view',
  'sub_roles.edit',
  // Onboarding
  'applications.view',
  'applications.message',
  'retailer.approve',
  'retailer.reject',
  'retailer.suspend',
  'retailer.terminate',
  'retailer.reinstate',
  // Compliance
  'kyc.review',
  'kyc.decide',
  'change_requests.view',
  'change_requests.decide',
  'policy_enforcement.create',
  'data_exports.manage',
  'account_deletions.manage',
  // Moderation
  'moderation.view',
  'moderation.decide',
  'moderation.appeal_resolve',
  // Inventory (admin override)
  'inventory.adjust',
  // Orders / refunds / disputes
  'orders.view',
  'orders.cancel',
  'orders.force_transition',
  'refunds.view',
  'refunds.force',
  'refunds.recovery_decide',
  'disputes.view',
  'disputes.decide',
  'held_items.view',
  'held_items.extend',
  // Promotions / vouchers / clubbing
  'promotions.view',
  'promotions.create',
  'promotions.publish',
  'promotions.revoke',
  'vouchers.create',
  'vouchers.revoke',
  'clubbing.view',
  'clubbing.edit',
  // Loyalty
  'loyalty.view',
  'loyalty.adjust',
  // Payouts / settlement / invoicing
  'payouts.view',
  'payouts.initiate',
  'payouts.hold',
  'early_disbursement.decide',
  'wallet_payouts.process',
  'invoicing.numbering.edit',
  'invoicing.gst_returns.generate',
  'post_payout_recovery.manage',
  // Misc admin
  'community.moderate',
  'consumers.view',
  'consumers.suspend',
  'consumers.create',
  'audit_log.view',
  'impersonation.start',
  'impersonation.end',
  'platform_config.edit',
  'platform_config.view',
  'reports.view',
  'store_management.view',
  'store_management.edit',
  'simulate.run',
  // Phase 4 store ops (admin overrides)
  'store.holidays_edit',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export const RETAILER_ACTIONS = [
  // Staff
  'staff.list',
  'staff.invite',
  'staff.create',
  'staff.deactivate',
  'staff.reactivate',
  'staff.change_role',
  'staff.reset_password',
  // Store profile / pause / holidays
  'store.view_profile',
  'store.edit_profile',
  'store.pause',
  'store.resume',
  'store.holidays_edit',
  // Listings / catalog
  'listings.view',
  'listings.create',
  'listings.edit',
  'listings.publish',
  'listings.retire',
  'attribute_templates.view',
  'attribute_templates.edit',
  // Inventory
  'inventory.view',
  'inventory.adjust',
  'inventory.import',
  'inventory.export',
  // Orders / returns / disputes
  'orders.view',
  'orders.accept',
  'orders.pack',
  'orders.handover',
  'orders.mark_delivered',
  'orders.cancel_request',
  'returns.view',
  'returns.accept',
  'returns.reject',
  'held_items.view',
  'disputes.view',
  'disputes.respond',
  'issues.create',
  // Delivery agent (retailer sub-role 'delivery_agent'). `delivery.view`/`delivery.act`
  // scope the agent's own assigned-delivery surface; `delivery.assign` lets owners/
  // managers assign an agent to an order at handover.
  'delivery.view',
  'delivery.act',
  'delivery.assign',
  // Promotions / vouchers
  'promotions.view',
  'promotions.create',
  'promotions.edit',
  'promotions.publish',
  'promotions.revoke',
  'vouchers.view',
  'vouchers.generate',
  // Compliance
  'change_requests.view',
  'change_requests.submit',
  'kyc.respond',
  'compliance.view',
  // Settlement
  'payouts.view',
  'early_disbursement.request',
  'invoicing.view',
  'fees.view',
  // Offline POS (counter sales). `pos.sell` rings + holds; `pos.view` reads history,
  // day summary, reprints; `pos.refund` voids/returns; `pos.labels` prints barcodes;
  // `pos.settings` edits tax/receipt config; `pos.manage` opens/closes the day + reconciles cash.
  'pos.sell',
  'pos.view',
  'pos.refund',
  'pos.labels',
  'pos.settings',
  'pos.manage',
  // Reports / AI / notifications / community
  'reports.view',
  'ai_catalog.generate',
  'notifications.read',
  'community.moderate',
  'application.messages.view',
  'application.messages.send',
] as const;
export type RetailerAction = (typeof RETAILER_ACTIONS)[number];

// ───── Defaults ───────────────────────────────────────────────────────────

const ADMIN_READ_ONLY: AdminAction[] = [
  'team.list',
  'sub_roles.view',
  'applications.view',
  'kyc.review',
  'change_requests.view',
  'moderation.view',
  'orders.view',
  'refunds.view',
  'disputes.view',
  'held_items.view',
  'promotions.view',
  'clubbing.view',
  'loyalty.view',
  'payouts.view',
  'consumers.view',
  'audit_log.view',
  'reports.view',
  'platform_config.view',
  'store_management.view',
];

function fullAdminMap(value: boolean): Record<AdminAction, boolean> {
  const out = {} as Record<AdminAction, boolean>;
  for (const a of ADMIN_ACTIONS) out[a] = value;
  return out;
}
function fullRetailerMap(value: boolean): Record<RetailerAction, boolean> {
  const out = {} as Record<RetailerAction, boolean>;
  for (const a of RETAILER_ACTIONS) out[a] = value;
  return out;
}

function adminDefaultsForSubRole(subRole: AdminSubRole): Record<AdminAction, boolean> {
  if (subRole === 'super_admin') {
    return fullAdminMap(true);
  }
  if (subRole === 'ops_admin') {
    const map = fullAdminMap(true);
    // ops_admin: no team CRUD beyond list, no sub_roles editing, no platform_config edits, no terminate
    map['team.create'] = false;
    map['team.update'] = false;
    map['team.revoke'] = false;
    map['team.reinstate'] = false;
    map['team.reset_password'] = false;
    map['sub_roles.edit'] = false;
    map['platform_config.edit'] = false;
    map['retailer.terminate'] = false;
    return map;
  }
  // support: read-only
  const map = fullAdminMap(false);
  for (const a of ADMIN_READ_ONLY) map[a] = true;
  return map;
}

const RETAILER_OWNER_RESERVED: RetailerAction[] = [
  'staff.deactivate',
  'staff.reactivate',
  'staff.change_role',
  'staff.reset_password',
  'store.pause',
  'store.resume',
];

// Floor-staff defaults — only the day-to-day operational surfaces. Reports,
// finance (fees/invoicing/payouts), compliance, and staff management default
// to denied. Owners override via the admin sub-role editor when they want
// individual staff to see more.
const RETAILER_STAFF_ALLOWED: RetailerAction[] = [
  'store.view_profile',
  'listings.view',
  'attribute_templates.view',
  'inventory.view',
  'inventory.adjust',
  'orders.view',
  'orders.accept',
  'orders.pack',
  'orders.handover',
  'orders.mark_delivered',
  'returns.view',
  'returns.accept',
  'returns.reject',
  'held_items.view',
  'disputes.view',
  'promotions.view',
  'vouchers.view',
  'notifications.read',
  'application.messages.view',
  // Staff run the counter: sell + read. Refunds/voids, labels and settings stay
  // owner/manager by default (owners can grant more via the sub-role editor).
  'pos.sell',
  'pos.view',
  'pos.labels',
];

// Delivery-agent defaults — only the agent's own delivery surface. Everything
// else (catalog, finance, staff, returns verification, etc.) is denied; the agent
// dashboard is a narrow, focused view of assigned deliveries.
const RETAILER_AGENT_ALLOWED: RetailerAction[] = [
  'delivery.view',
  'delivery.act',
  'notifications.read',
];

function retailerDefaultsForSubRole(subRole: RetailerSubRole): Record<RetailerAction, boolean> {
  if (subRole === 'owner') {
    return fullRetailerMap(true);
  }
  if (subRole === 'manager') {
    const map = fullRetailerMap(true);
    for (const a of RETAILER_OWNER_RESERVED) map[a] = false;
    return map;
  }
  if (subRole === 'delivery_agent') {
    const map = fullRetailerMap(false);
    for (const a of RETAILER_AGENT_ALLOWED) map[a] = true;
    return map;
  }
  // staff
  const map = fullRetailerMap(false);
  for (const a of RETAILER_STAFF_ALLOWED) map[a] = true;
  return map;
}

const ADMIN_DEFAULTS: Record<AdminSubRole, Record<AdminAction, boolean>> = {
  super_admin: adminDefaultsForSubRole('super_admin'),
  ops_admin: adminDefaultsForSubRole('ops_admin'),
  support: adminDefaultsForSubRole('support'),
};

const RETAILER_DEFAULTS: Record<RetailerSubRole, Record<RetailerAction, boolean>> = {
  owner: retailerDefaultsForSubRole('owner'),
  manager: retailerDefaultsForSubRole('manager'),
  staff: retailerDefaultsForSubRole('staff'),
  delivery_agent: retailerDefaultsForSubRole('delivery_agent'),
};

// ───── Resolution ─────────────────────────────────────────────────────────

type Override = InferSelectModel<typeof subRolePermissionOverrides>;

/** Pure resolver — given overrides[], return effective permission. */
export function resolvePermission(
  scope: 'admin' | 'retailer',
  subRole: string,
  action: string,
  overrides: Override[],
): boolean {
  const match = overrides.find(
    (o) => o.scope === scope && o.subRole === subRole && o.action === action,
  );
  if (match !== undefined) return match.allowed;

  const defaults =
    scope === 'admin'
      ? ADMIN_DEFAULTS[subRole as AdminSubRole]
      : RETAILER_DEFAULTS[subRole as RetailerSubRole];

  if (!defaults) return false;
  return (defaults as Record<string, boolean>)[action] ?? false;
}

/** Async DB-backed lookup. Returns true iff the sub-role is allowed `action`. */
export async function isAllowed(
  scope: 'admin' | 'retailer',
  subRole: string,
  action: string,
): Promise<boolean> {
  const overrideRows = await db
    .select()
    .from(subRolePermissionOverrides)
    .where(
      and(
        eq(subRolePermissionOverrides.scope, scope),
        eq(subRolePermissionOverrides.subRole, subRole),
        eq(subRolePermissionOverrides.action, action),
      ),
    );
  return resolvePermission(scope, subRole, action, overrideRows);
}

/** Build the merged default+override map for one sub-role. */
export async function effectivePermissions(
  scope: 'admin' | 'retailer',
  subRole: string,
): Promise<Record<string, boolean>> {
  const overrideRows = await db
    .select()
    .from(subRolePermissionOverrides)
    .where(
      and(
        eq(subRolePermissionOverrides.scope, scope),
        eq(subRolePermissionOverrides.subRole, subRole),
      ),
    );
  const actions = scope === 'admin' ? ADMIN_ACTIONS : RETAILER_ACTIONS;
  const out: Record<string, boolean> = {};
  for (const a of actions) {
    out[a] = resolvePermission(scope, subRole, a, overrideRows);
  }
  return out;
}

export function getDefaultMatrix(scope: 'admin' | 'retailer') {
  return scope === 'admin' ? ADMIN_DEFAULTS : RETAILER_DEFAULTS;
}

export const ALL_ACTIONS = {
  admin: ADMIN_ACTIONS,
  retailer: RETAILER_ACTIONS,
} as const;

// ───── Fastify pre-handler factory ────────────────────────────────────────

/**
 * Build a Fastify preHandler that asserts the calling user's sub-role is
 * granted `action`. Pair with the existing `requireAuth(kind)` preHandler
 * which validates the token kind and populates `req.auth`. Throws
 * `AppError.forbidden('Insufficient permission for "<action>"')` (HTTP
 * 403) on denial.
 *
 * Action keys are checked at the type level — pass `AdminAction` for admin
 * routes and `RetailerAction` for retailer routes.
 */
export function requirePermission(
  action: AdminAction | RetailerAction,
): preHandlerAsyncHookHandler {
  return async function permissionGate(
    req: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(500, ErrorCode.InternalError, 'requirePermission called without requireAuth preHandler');
    }
    const scope: 'admin' | 'retailer' | null =
      auth.kind === 'admin' ? 'admin' : auth.kind === 'retailer' ? 'retailer' : null;
    if (!scope) {
      // Consumer or other token kinds — no sub-role matrix applies; deny.
      throw AppError.forbidden(`Insufficient permission for "${action}"`);
    }
    const subRole = auth.subRole;
    if (!subRole) {
      throw AppError.forbidden(`Insufficient permission for "${action}"`);
    }
    const allowed = await isAllowed(scope, subRole, action);
    if (!allowed) {
      throw AppError.forbidden(`Insufficient permission for "${action}"`);
    }
  };
}
