/**
 * Pure unit coverage for the retailer online/offline "accepting orders" helpers.
 * No DB — just the IST next-open math and the lazy accepting predicate.
 */
import { describe, expect, it } from 'vitest';

import { isAcceptingOrders, nextStoreOpenAt } from '@/shared/store/order-acceptance.js';

const ALL_DAYS_9_TO_6 = {
  monday: [{ open: '09:00', close: '18:00' }],
  tuesday: [{ open: '09:00', close: '18:00' }],
  wednesday: [{ open: '09:00', close: '18:00' }],
  thursday: [{ open: '09:00', close: '18:00' }],
  friday: [{ open: '09:00', close: '18:00' }],
  saturday: [{ open: '09:00', close: '18:00' }],
  sunday: [{ open: '09:00', close: '18:00' }],
};

// 2026-07-21 10:00 IST (Tuesday) === 2026-07-21T04:30:00Z
const NOW = new Date('2026-07-21T04:30:00Z');

describe('nextStoreOpenAt', () => {
  it('reopens at the NEXT DAY opening window, not later today', () => {
    const at = nextStoreOpenAt(ALL_DAYS_9_TO_6, new Set(), NOW);
    // 2026-07-22 09:00 IST === 2026-07-22T03:30:00Z
    expect(at.toISOString()).toBe('2026-07-22T03:30:00.000Z');
  });

  it('skips holiday-closed dates', () => {
    const at = nextStoreOpenAt(ALL_DAYS_9_TO_6, new Set(['2026-07-22']), NOW);
    // rolls to 2026-07-23 09:00 IST === 2026-07-23T03:30:00Z
    expect(at.toISOString()).toBe('2026-07-23T03:30:00.000Z');
  });

  it('falls back to next IST midnight when no hours are configured', () => {
    const at = nextStoreOpenAt({}, new Set(), NOW);
    // 2026-07-22 00:00 IST === 2026-07-21T18:30:00Z
    expect(at.toISOString()).toBe('2026-07-21T18:30:00.000Z');
  });

  it('skips a day that is explicitly closed (empty slots)', () => {
    const hours = { ...ALL_DAYS_9_TO_6, wednesday: [] };
    const at = nextStoreOpenAt(hours, new Set(), NOW);
    // Wed 2026-07-22 closed → Thu 2026-07-23 09:00 IST
    expect(at.toISOString()).toBe('2026-07-23T03:30:00.000Z');
  });
});

describe('isAcceptingOrders', () => {
  it('accepts when orderPauseUntil is null', () => {
    expect(isAcceptingOrders({ orderPauseUntil: null }, NOW)).toBe(true);
  });

  it('rejects while orderPauseUntil is in the future', () => {
    const future = new Date(NOW.getTime() + 3_600_000);
    expect(isAcceptingOrders({ orderPauseUntil: future }, NOW)).toBe(false);
  });

  it('accepts again once orderPauseUntil is in the past (lazy auto-reopen)', () => {
    const past = new Date(NOW.getTime() - 1000);
    expect(isAcceptingOrders({ orderPauseUntil: past }, NOW)).toBe(true);
  });
});
