import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareFn } from "grammy";
import type { Logger } from "../../../logger.js";

/** The single rejection text; never varies by reason (FR-7, AC-8). */
export const UNAUTHORIZED_TEXT = "⛔ Unauthorized";

export interface AllowlistOptions {
  readonly allowedUserIds: ReadonlySet<number>;
  readonly logger: Logger;
  /** Per-process random salt by default; injectable for tests. */
  readonly salt?: string;
}

/** Salted SHA-256 prefix of a user id, so logs never carry the raw id (NFR-5). */
export function hashUserId(userId: number | undefined, salt: string): string {
  const input = userId === undefined ? "none" : String(userId);
  return createHash("sha256").update(`${salt}:${input}`).digest("hex").slice(0, 12);
}

/**
 * First middleware of the bot (architecture §7.1): lets an update through only when its sender
 * is on the allowlist. Anything else gets exactly {@link UNAUTHORIZED_TEXT}, creates no state
 * and is logged with a hashed id only.
 */
export function allowlistMiddleware(options: AllowlistOptions): MiddlewareFn<Context> {
  const salt = options.salt ?? randomBytes(16).toString("hex");
  const { allowedUserIds, logger } = options;

  return async (ctx, next) => {
    const userId = ctx.update.message?.from?.id ?? ctx.update.callback_query?.from?.id;
    if (userId !== undefined && allowedUserIds.has(userId)) {
      await next();
      return;
    }

    // `chat_ref` is the logger's allowlisted field for a hashed identifier (architecture §11).
    logger.warn("Rejected update from a user outside the allowlist", {
      event: "telegram.update.rejected",
      chat_ref: hashUserId(userId, salt),
    });

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
