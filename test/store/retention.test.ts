import { afterEach, describe, expect, it, vi } from "vitest";
import { runRetention, scheduleRetention, type RetentionJobOptions } from "../../src/store/retention.js";
import { createRecordingLogger } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

function fakes(calls: string[]) {
  return {
    bindings: {
      pruneInactive: vi.fn((maxAgeMs: number) => {
        calls.push(`bindings:${String(maxAgeMs)}`);
        return 2;
      }),
    },
    confirmations: {
      expireUnresolved: vi.fn((maxAgeMs: number) => {
        calls.push(`expire:${String(maxAgeMs)}`);
        return 1;
      }),
      prune: vi.fn(() => {
        calls.push("confirmations");
        return 3;
      }),
    },
    seen: {
      pruneAll: vi.fn(() => {
        calls.push("seen");
        return 4;
      }),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runRetention", () => {
  it("expires unanswered prompts first, then prunes with the configured age, and reports counts", () => {
    const calls: string[] = [];
    const logger = createRecordingLogger();
    const options: RetentionJobOptions = { ...fakes(calls), logger, retentionDays: 14 };

    expect(runRetention(options)).toEqual({
      expiredConfirmations: 1,
      prunedBindings: 2,
      prunedConfirmations: 3,
      prunedSeenEvents: 4,
    });

    expect(calls).toEqual([`expire:${String(14 * DAY)}`, `bindings:${String(14 * DAY)}`, "confirmations", "seen"]);
    expect(logger.records.at(-1)).toMatchObject({
      level: "info",
      fields: {
        event: "retention.done",
        expired_confirmations: 1,
        pruned_bindings: 2,
        pruned_confirmations: 3,
        pruned_seen_events: 4,
      },
    });
  });

  it("never throws: a failing pass is logged with the error type only and reports null", () => {
    const calls: string[] = [];
    const logger = createRecordingLogger();
    const parts = fakes(calls);
    parts.bindings.pruneInactive.mockImplementation(() => {
      throw new RangeError("secret-looking detail");
    });

    expect(runRetention({ ...parts, logger, retentionDays: 30 })).toBeNull();

    const record = logger.records.at(-1);
    expect(record).toMatchObject({ level: "error", fields: { event: "retention.failed", err_type: "RangeError" } });
    expect(JSON.stringify(record)).not.toContain("secret-looking");
  });
});

describe("scheduleRetention", () => {
  it("runs immediately, then every interval, and the returned stop function ends the timer", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const parts = fakes(calls);
    const stop = scheduleRetention({ ...parts, logger: createRecordingLogger(), retentionDays: 30 }, 1000);

    expect(parts.bindings.pruneInactive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(parts.bindings.pruneInactive).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(10_000);
    expect(parts.bindings.pruneInactive).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
