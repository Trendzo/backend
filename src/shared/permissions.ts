/**
 * Default sub-role permission matrix. The DB table `sub_role_permission_overrides`
 * stores only deviations from these defaults. Call `resolvePermission()` at
 * request time to get the effective allowed/denied value.
 *
 * Actions use dotted-path keys: `<resource>.<verb>`.
 */

export type AdminSubRole = 'super_admin' | 'ops_admin' | 'support';
export type RetailerSubRole = 'owner' | 'manager' | 'staff';

// super_admin: unrestricted; ops_admin: no team-management; support: read-only
const ADMIN_DEFAULTS: Record<AdminSubRole, Record<string, boolean>> = {
  super_admin: {
    'team.create': true,
    'team.revoke': true,
    'sub_roles.edit': true,
    'retailer.approve': true,
    'retailer.reject': true,
    'retailer.suspend': true,
    'retailer.terminate': true,
    'compliance.resolve': true,
    'impersonation.start': true,
    'audit_log.view': true,
  },
  ops_admin: {
    'team.create': false,
    'team.revoke': false,
    'sub_roles.edit': false,
    'retailer.approve': true,
    'retailer.reject': true,
    'retailer.suspend': true,
    'retailer.terminate': false,
    'compliance.resolve': true,
    'impersonation.start': true,
    'audit_log.view': true,
  },
  support: {
    'team.create': false,
    'team.revoke': false,
    'sub_roles.edit': false,
    'retailer.approve': false,
    'retailer.reject': false,
    'retailer.suspend': false,
    'retailer.terminate': false,
    'compliance.resolve': false,
    'impersonation.start': false,
    'audit_log.view': true,
  },
};

// owner: all; manager: no staff-invite/revoke for owners; staff: read-only ops
const RETAILER_DEFAULTS: Record<RetailerSubRole, Record<string, boolean>> = {
  owner: {
    'staff.invite': true,
    'staff.revoke': true,
    'staff.change_role': true,
    'listings.publish': true,
    'listings.retire': true,
    'store.pause': true,
    'promotions.create': true,
    'promotions.delete': true,
  },
  manager: {
    'staff.invite': true,
    'staff.revoke': false,
    'staff.change_role': false,
    'listings.publish': true,
    'listings.retire': true,
    'store.pause': false,
    'promotions.create': true,
    'promotions.delete': true,
  },
  staff: {
    'staff.invite': false,
    'staff.revoke': false,
    'staff.change_role': false,
    'listings.publish': false,
    'listings.retire': false,
    'store.pause': false,
    'promotions.create': false,
    'promotions.delete': false,
  },
};

import type { subRolePermissionOverrides } from '@/db/schema/index.js';
import type { InferSelectModel } from 'drizzle-orm';

type Override = InferSelectModel<typeof subRolePermissionOverrides>;

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

  return defaults?.[action] ?? false;
}

export function getDefaultMatrix(scope: 'admin' | 'retailer') {
  return scope === 'admin' ? ADMIN_DEFAULTS : RETAILER_DEFAULTS;
}
