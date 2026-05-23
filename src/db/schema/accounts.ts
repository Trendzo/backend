/**
 * §1 Identity & Access — schema additions.
 *
 * Adds the audit, impersonation, password-reset, staff-invite, and sub-role
 * permission-matrix tables that the dashboard's Phase 1 surfaces (admin team,
 * sub-roles editor, retailer staff invites, impersonation banner, password
 * reset OTP, action audit log) depend on.
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  actorType,
  passwordResetTokenKind,
  retailerSubRole,
  staffInviteStatus,
  subRoleScope,
} from './enums.js';
import { adminAccounts } from './identity.js';
import { retailerAccounts, retailerStores } from './store.js';

/**
 * Audit log for every privileged action: account approvals, sub-role changes,
 * impersonation start/stop, store suspensions, listing takedowns, etc.
 *
 * `actor` is polymorphic (admin/retailer/system); `resource` is the entity
 * touched. `before`/`after` carry just the fields that changed so a small
 * blob is enough to reconstruct what happened. Backfilled by the
 * `recordAudit()` helper in `shared/audit.ts`.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    actorKind: actorType('actor_kind').notNull(),
    actorId: text('actor_id'), // null for system
    // Free-form action key e.g. `retailer.approve`, `staff.invite`,
    // `impersonation.start`. Loose contract: dotted path, lowercase.
    action: text('action').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    // Stored only for admin actors mid-impersonation. Lets retailers query
    // "actions on my store" and see both the admin and the impersonated
    // store-id without joining a separate session record.
    impersonatedStoreId: text('impersonated_store_id'),
    requestId: text('request_id'),
    note: text('note'),
  },
  (t) => ({
    actorIdx: uniqueIndex('audit_log_actor_at_idx').on(t.id, t.actorKind, t.actorId, t.at),
  }),
);

export const auditLogRelations = relations(auditLog, () => ({}));

/**
 * One row per impersonation session. Open while `endedAt IS NULL`. Each
 * session is a parent of zero-to-many audit_log entries via
 * `audit_log.impersonated_store_id`.
 */
export const impersonationSessions = pgTable('impersonation_sessions', {
  id: text('id').primaryKey(),
  adminId: text('admin_id')
    .notNull()
    .references(() => adminAccounts.id, { onDelete: 'restrict' }),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id, { onDelete: 'restrict' }),
  // Cached for quick filtering — same as retailer that owns the store at start.
  retailerId: text('retailer_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
  reason: text('reason'),
});

export const impersonationSessionsRelations = relations(impersonationSessions, ({ one }) => ({
  admin: one(adminAccounts, {
    fields: [impersonationSessions.adminId],
    references: [adminAccounts.id],
  }),
  store: one(retailerStores, {
    fields: [impersonationSessions.storeId],
    references: [retailerStores.id],
  }),
}));

/**
 * Single-use OTP for password reset. We store the bcrypt hash of the code,
 * not the raw value, so a leaked DB row cannot be replayed.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    accountKind: passwordResetTokenKind('account_kind').notNull(),
    // Identifier within the chosen account_kind table — admin_accounts.id,
    // retailer_accounts.id, or consumers.id. Not declared as FK because the
    // target column varies; integrity is enforced in the route layer.
    accountId: text('account_id').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountIdx: uniqueIndex('password_reset_tokens_account_id_idx').on(
      t.id,
      t.accountKind,
      t.accountId,
    ),
  }),
);

export const passwordResetTokensRelations = relations(passwordResetTokens, () => ({}));

/**
 * Pending invites to retailer staff. Once accepted, a row is created in
 * `retailer_accounts` and `accepted_at` is set here. `tokenHash` is a
 * single-use bcrypt-hashed claim token sent in the invite email.
 */
export const retailerStaffInvites = pgTable(
  'retailer_staff_invites',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    subRole: retailerSubRole('sub_role').notNull(),
    invitedByAccountId: text('invited_by_account_id')
      .notNull()
      .references(() => retailerAccounts.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
    status: staffInviteStatus('status').notNull().default('pending'),
  },
  (t) => ({
    storeEmailIdx: uniqueIndex('retailer_staff_invites_store_email_pending_idx').on(
      t.storeId,
      t.email,
      t.status,
    ),
  }),
);

export const retailerStaffInvitesRelations = relations(retailerStaffInvites, ({ one }) => ({
  store: one(retailerStores, {
    fields: [retailerStaffInvites.storeId],
    references: [retailerStores.id],
  }),
  invitedBy: one(retailerAccounts, {
    fields: [retailerStaffInvites.invitedByAccountId],
    references: [retailerAccounts.id],
  }),
}));

/**
 * Sub-role × action permission matrix. The default policy lives in code
 * (`shared/permissions.ts`); this table only records super-admin overrides.
 *
 * Composite primary key (scope, sub_role, action) makes the lookup a pure
 * point-read at request time.
 */
export const subRolePermissionOverrides = pgTable(
  'sub_role_permission_overrides',
  {
    scope: subRoleScope('scope').notNull(),
    // Encoded as text so a single column covers both
    // `admin_sub_role` (super_admin|ops_admin|support) and
    // `retailer_sub_role` (owner|manager|staff). Validated at write time
    // against the enum that matches `scope`.
    subRole: text('sub_role').notNull(),
    action: text('action').notNull(),
    allowed: boolean('allowed').notNull(),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedByAccountId: text('updated_by_account_id'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.subRole, t.action] }),
  }),
);

export const subRolePermissionOverridesRelations = relations(
  subRolePermissionOverrides,
  () => ({}),
);
