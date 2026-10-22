import type { Logger } from "../logger.js";
import type { ConversationBindingRepository } from "./conversation-binding.js";
import type { PendingConfirmationRepository } from "./pending-confirmation.js";
import type { SeenEventRepository } from "./seen-event.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the scheduled retention job runs after the run at startup. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionJobOptions {
  readonly bindings: Pick<ConversationBindingRepository, "pruneInactive">;
  readonly confirmations: Pick<PendingConfirmationRepository, "expireUnresolved" | "prune">;
  readonly seen: Pick<SeenEventRepository, "pruneAll">;
  readonly logger: Logger;
  /** Age after which an inactive binding is pruned and an unanswered confirmation expires. */
  readonly retentionDays: number;
}

export interface RetentionResult {
  readonly expiredConfirmations: number;
  readonly prunedBindings: number;
  readonly prunedConfirmations: number;
  readonly prunedSeenEvents: number;
}

/**
 * One retention pass (architecture §8), in dependency order: unanswered confirmations expire
 * first (so they stop pinning their binding), then inactive bindings go together with their
 * cursor and dedupe rows, then resolved confirmations and old dedupe rows are trimmed.
 * Never throws: a failing pass is logged (error type only) and retried at the next tick.
 */
export function runRetention(options: RetentionJobOptions): RetentionResult | null {
  const maxAgeMs = options.retentionDays * DAY_MS;
  try {
    const result: RetentionResult = {
      expiredConfirmations: options.confirmations.expireUnresolved(maxAgeMs),
      prunedBindings: options.bindings.pruneInactive(maxAgeMs),
      prunedConfirmations: options.confirmations.prune(),
      prunedSeenEvents: options.seen.pruneAll(),
    };
    const removed = Object.values(result).reduce((sum, count) => sum + count, 0);
    options.logger[removed > 0 ? "info" : "debug"]("Retention pass finished", {
      event: "retention.done",
      expired_confirmations: result.expiredConfirmations,
      pruned_bindings: result.prunedBindings,
      pruned_confirmations: result.prunedConfirmations,
      pruned_seen_events: result.prunedSeenEvents,
    });
    return result;
  } catch (error) {
    options.logger.error("Retention pass failed", {
      event: "retention.failed",
      err_type: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

/**
 * Runs {@link runRetention} now and then every `intervalMs`. The returned function stops the
 * timer (called on shutdown, before the store is closed). The timer is unref'd so it alone never
 * keeps the process alive.
 */
export function scheduleRetention(
  options: RetentionJobOptions,
  intervalMs: number = RETENTION_INTERVAL_MS,
): () => void {
  runRetention(options);
  const timer = setInterval(() => {
    runRetention(options);
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
