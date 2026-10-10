import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareFn } from "grammy";
import type { Logger } from "../../../logger.js";

/** The single rejection text; never varies by reason (FR-7, AC-8). */
export const UNAUTHORIZED_TEXT = "⛔ Unauthorized";

export const DEFAULT_REJECTION_WINDOW_MS = 60_000;
export const DEFAULT_MAX_TRACKED_SENDERS = 1_000;

export interface AllowlistOptions {
  readonly allowedUserIds: ReadonlySet<number>;
  readonly logger: Logger;
  /** Per-process random salt by default; injectable for tests. */
  readonly salt?: string;
  /** Per-sender window: one reply and one log line per window (default 60 s). */
  readonly rejectionWindowMs?: number;
  /** Upper bound of senders tracked at once; the oldest is evicted beyond it (default 1000). */
  readonly maxTrackedSenders?: number;
  readonly now?: () => number;
}

/** Salted SHA-256 prefix of a user id, so logs never carry the raw id (NFR-5). */
export function hashUserId(userId: number | undefined, salt: string): string {
  const input = userId === undefined ? "none" : String(userId);
  return createHash("sha256").update(`${salt}:${input}`).digest("hex").slice(0, 12);
}

interface SenderWindow {
  windowStart: number;
  suppressed: number;
}

/**
 * Bounded per-sender rate limiter for rejections. The first rejection of a sender in a window is
 * answered and logged; the rest are counted and reported in one summary line when the sender's
 * next window starts or its entry is evicted. Memory never exceeds `maxEntries` senders, so a
 * flood of distinct unauthorized senders cannot grow it (or the log) without bound.
 */
export class RejectionThrottle {
  private readonly entries = new Map<string, SenderWindow>();

  constructor(
    private readonly logger: Logger,
    private readonly windowMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Returns true when this rejection is the first of its window and must be answered and logged. */
  admit(senderHash: string): boolean {
    const now = this.now();
    const current = this.entries.get(senderHash);
    if (current !== undefined && now - current.windowStart < this.windowMs) {
      current.suppressed += 1;
      return false;
    }
    if (current !== undefined) {
      this.report(senderHash, current);
      this.entries.delete(senderHash);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.entries().next();
      if (oldest.done) {
        break;
      }
      this.report(oldest.value[0], oldest.value[1]);
      this.entries.delete(oldest.value[0]);
    }
    this.entries.set(senderHash, { windowStart: now, suppressed: 0 });
    return true;
  }

  private report(senderHash: string, window: SenderWindow): void {
    if (window.suppressed === 0) {
      return;
    }
    // The logger's field allowlist has no counter field, so the count lives in the message.
    this.logger.warn(`Suppressed ${window.suppressed} further rejected updates from one sender`, {
      event: "telegram.update.rejected_summary",
      chat_ref: senderHash,
    });
  }
}

/**
 * First middleware of the bot (architecture §7.1): lets an update through only when its sender
 * is on the allowlist. Anything else gets exactly {@link UNAUTHORIZED_TEXT} (at most once per
 * sender per window, and never in group chats), creates no state and is logged with a hashed id.
 */
export function allowlistMiddleware(options: AllowlistOptions): MiddlewareFn<Context> {
  const salt = options.salt ?? randomBytes(16).toString("hex");
  const { allowedUserIds, logger } = options;
  const throttle = new RejectionThrottle(
    logger,
    options.rejectionWindowMs ?? DEFAULT_REJECTION_WINDOW_MS,
    options.maxTrackedSenders ?? DEFAULT_MAX_TRACKED_SENDERS,
    options.now ?? Date.now,
  );

  return async (ctx, next) => {
    const userId = ctx.update.message?.from?.id ?? ctx.update.callback_query?.from?.id;
    if (userId !== undefined && allowedUserIds.has(userId)) {
      await next();
      return;
    }

    const senderHash = hashUserId(userId, salt);
    if (!throttle.admit(senderHash)) {
      return;
    }

    // `chat_ref` is the logger's allowlisted field for a hashed identifier (architecture §11).
    logger.warn("Rejected update from a user outside the allowlist", {
      event: "telegram.update.rejected",
      chat_ref: senderHash,
    });

    // Stay silent in groups and channels: a reply there would advertise the bot to strangers.
    const chatType = ctx.chat?.type;
    if (chatType !== undefined && chatType !== "private") {
      return;
    }

    try {
      if (ctx.update.callback_query !== undefined) {
        await ctx.answerCallbackQuery({ text: UNAUTHORIZED_TEXT });
      } else if (ctx.chat !== undefined) {
        await ctx.reply(UNAUTHORIZED_TEXT);
      }
    } catch (error) {
      logger.warn("Could not deliver the unauthorized reply", {
        event: "telegram.update.reject_reply_failed",
        err_type: error instanceof Error ? error.name : typeof error,
      });
    }
  };
}
