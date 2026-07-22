/**
 * Retailer self-serve "stop accepting orders" toggle.
 *
 * A store's `orderPauseUntil` is NULL while it accepts orders. When the retailer
 * flips the store offline we set it to the START of the store's next opening
 * window (IST); the store stops accepting orders until that instant, then
 * auto-reopens. Correctness is enforced lazily at order time (`isAcceptingOrders`)
 * and a lifecycle sweep flips the column back to NULL so the UI reflects it.
 *
 * India observes no DST, so a fixed +05:30 offset is exact and avoids pulling in
 * a timezone library.
 */

const IST_OFFSET_MIN = 330; // +05:30
const IST_OFFSET_MS = IST_OFFSET_MIN * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

type OpeningHours = Record<string, { open: string; close: string }[]> | null | undefined;

/** The wall-clock IST parts of a UTC instant. */
function istParts(instant: Date) {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-11
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0=Sun
  };
}

/** UTC instant for a given IST calendar date + "HH:MM" wall time. */
function istWallToUtc(year: number, month: number, day: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  const asUtc = Date.UTC(year, month, day, h || 0, m || 0, 0, 0);
  return new Date(asUtc - IST_OFFSET_MS);
}

/** IST YYYY-MM-DD for a UTC instant (matches store_holiday_closures.date). */
function istDateStr(instant: Date): string {
  const { year, month, day } = istParts(instant);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Earliest "HH:MM" open time for a day's slot list, or null when closed. */
function earliestOpen(slots: { open: string; close: string }[] | undefined): string | null {
  if (!slots || slots.length === 0) return null;
  return slots.map((s) => s.open).sort()[0] ?? null;
}

/**
 * The instant the store should next start accepting orders after going offline
 * NOW. Per product spec this is the store's NEXT DAY opening window (offline
 * skips the rest of today), scanning forward up to two weeks and skipping
 * holiday-closed dates. Falls back to the next IST midnight when no opening
 * hours are configured (or none found in range) so the store is never stuck
 * closed.
 */
export function nextStoreOpenAt(
  openingHours: OpeningHours,
  holidayDates: ReadonlySet<string>,
  now: Date,
): Date {
  const today = istParts(now);
  const todayMidnightUtc = istWallToUtc(today.year, today.month, today.day, '00:00');

  for (let offset = 1; offset <= 14; offset++) {
    const dayStart = new Date(todayMidnightUtc.getTime() + offset * DAY_MS);
    const parts = istParts(dayStart);
    const dateStr = istDateStr(dayStart);
    if (holidayDates.has(dateStr)) continue;
    const dayName = WEEKDAY_NAMES[parts.weekday]!;
    const open = earliestOpen(openingHours?.[dayName]);
    if (open) return istWallToUtc(parts.year, parts.month, parts.day, open);
  }

  // No configured opening in range — reopen at the next IST midnight.
  return new Date(todayMidnightUtc.getTime() + DAY_MS);
}

/**
 * Whether a store accepts orders right now. `orderPauseUntil` in the future =
 * closed; NULL or in the past = accepting (lazy auto-reopen). Note this does NOT
 * consider admin `status` — callers gate on that separately.
 */
export function isAcceptingOrders(
  store: { orderPauseUntil: Date | null },
  now: Date = new Date(),
): boolean {
  return store.orderPauseUntil == null || store.orderPauseUntil <= now;
}
