import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shared/orders/routing.js', () => ({
  processAcceptanceWindowSweep: vi.fn(async () => ({ swept: 0, cancelled: 0 })),
}));
vi.mock('./shared/orders/door-visit.js', () => ({ processDoorWindowSweep: vi.fn(async () => 0) }));
vi.mock('./shared/orders/lifecycle-sweeps.js', () => ({ runLifecycleSweeps: vi.fn(async () => ({})) }));
vi.mock('./shared/bulk-mockups/worker.js', () => ({ processBulkMockupQueue: vi.fn(async () => null) }));

import { startBackgroundJobs } from './background-jobs.js';
import { processBulkMockupQueue } from './shared/bulk-mockups/worker.js';
import { runLifecycleSweeps } from './shared/orders/lifecycle-sweeps.js';

const log = { info: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('startBackgroundJobs', () => {
  it('starts nothing when disabled', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startBackgroundJobs(log, false);
    vi.advanceTimersByTime(120_000);
    expect(spy).not.toHaveBeenCalled();
    expect(processBulkMockupQueue).not.toHaveBeenCalled();
    expect(runLifecycleSweeps).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    stop();
  });

  it('runs every loop when enabled, and stop() clears them', () => {
    vi.useFakeTimers();
    const stop = startBackgroundJobs(log, true);
    vi.advanceTimersByTime(60_000);
    expect(runLifecycleSweeps).toHaveBeenCalledTimes(1);
    expect(processBulkMockupQueue).toHaveBeenCalledTimes(12);

    stop();
    vi.advanceTimersByTime(120_000);
    expect(runLifecycleSweeps).toHaveBeenCalledTimes(1);
    expect(processBulkMockupQueue).toHaveBeenCalledTimes(12);
  });
});
