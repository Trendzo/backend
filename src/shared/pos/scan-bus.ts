/**
 * In-memory fan-out for the QR-scan → POS register feature.
 *
 * The retailer mobile app scans a product QR and pushes it (POST /retailer/pos/scan); an open
 * web-portal Register page subscribes over SSE (GET /retailer/pos/scan/stream). This bus routes
 * a pushed scan to the chosen Register session(s) of the same store.
 *
 * IMPORTANT: this is a single-process, in-memory registry. It does NOT fan out across multiple
 * backend instances. If the backend is ever scaled horizontally, replace the transport with
 * Postgres LISTEN/NOTIFY (the pg pool is already present) or Redis pub/sub, keyed by storeId.
 */

/** One connected web Register page (one SSE connection). */
export type RegisterSession = {
  id: string;
  label: string;
  storeId: string;
  connectedAt: number;
  /** Write a scan event to this session's SSE stream. */
  write: (row: unknown) => void;
};

/** Public shape returned to the app's device picker. */
export type RegisterInfo = { id: string; label: string; connectedAt: number };

/** Special target meaning "every Register open for the store". */
export const TARGET_ALL = 'all';

// storeId → (sessionId → session)
const byStore = new Map<string, Map<string, RegisterSession>>();

/** Register a live SSE session. Overwrites any prior session with the same id (reconnect). */
export function register(session: RegisterSession): void {
  let sessions = byStore.get(session.storeId);
  if (!sessions) {
    sessions = new Map();
    byStore.set(session.storeId, sessions);
  }
  sessions.set(session.id, session);
}

/** Remove a session on disconnect. Drops the store bucket once empty. */
export function unregister(storeId: string, sessionId: string): void {
  const sessions = byStore.get(storeId);
  if (!sessions) return;
  sessions.delete(sessionId);
  if (sessions.size === 0) byStore.delete(storeId);
}

/**
 * List the store's connected devices for the app's picker. Sessions are keyed per-connection
 * (one SSE = one session), but many tabs on the same browser share one device `label`, so we
 * collapse to one entry per label. The picker's target is therefore the device label.
 */
export function listByStore(storeId: string): RegisterInfo[] {
  const sessions = byStore.get(storeId);
  if (!sessions) return [];
  const byLabel = new Map<string, RegisterInfo>();
  for (const s of sessions.values()) {
    const existing = byLabel.get(s.label);
    if (!existing || s.connectedAt < existing.connectedAt) {
      byLabel.set(s.label, { id: s.label, label: s.label, connectedAt: s.connectedAt });
    }
  }
  return [...byLabel.values()].sort((a, b) => a.connectedAt - b.connectedAt);
}

/**
 * Deliver a scanned row to a store's target device(s). `target` is a device label or
 * {@link TARGET_ALL}; every connection (tab) with that label receives it. Returns the number of
 * connections that received it.
 */
export function publish(storeId: string, row: unknown, target: string): number {
  const sessions = byStore.get(storeId);
  if (!sessions) return 0;
  let delivered = 0;
  for (const session of sessions.values()) {
    if (target !== TARGET_ALL && session.label !== target) continue;
    try {
      session.write(row);
      delivered++;
    } catch {
      // A dead socket that hasn't fired 'close' yet — drop it so it can't wedge future sends.
      sessions.delete(session.id);
    }
  }
  if (sessions.size === 0) byStore.delete(storeId);
  return delivered;
}
