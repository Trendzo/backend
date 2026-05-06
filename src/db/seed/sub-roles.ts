/**
 * Sub-role definitions are encoded as Postgres enums (see `src/db/schema/enums.ts`):
 *   retailer_sub_role: owner | manager | staff
 *   admin_sub_role:    super_admin | ops_admin | support
 *
 * There is no separate sub-roles table — assignment is the `sub_role` column on
 * `retailer_accounts` / `admin_accounts`. This file is a placeholder so the seed
 * orchestrator can list every conceptual seed in one place.
 *
 * If sub-role permissions are ever moved into a dedicated table, this is where the
 * seed rows would land.
 */

import type { db as Db } from '@/db/client.js';

export function seedSubRoles(_db: typeof Db): Promise<void> {
  // Intentionally empty — sub-roles live in pgEnum, no row inserts needed.
  return Promise.resolve();
}
