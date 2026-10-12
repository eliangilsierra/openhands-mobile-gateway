import { Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import type { Logger } from "../../logger.js";
import type { ConfirmationService } from "../../core/confirmations.js";
import type { ProjectRegistry, SelectProjectDeps } from "../../core/projects.js";
import type { SessionControlDeps, SubmitTaskDeps } from "../../core/session.js";
import { registerHelp } from "./commands/help.js";
import { registerPause } from "./commands/pause.js";
import { registerProjects } from "./commands/projects.js";
import { registerResume } from "./commands/resume.js";
import { registerStart, type ChatStateStore } from "./commands/start.js";
import { registerStatus } from "./commands/status.js";
import { registerStop } from "./commands/stop.js";
import { registerUse } from "./commands/use.js";
import { registerConfirmationCallbacks } from "./handlers/callback.js";
import { registerText } from "./handlers/text.js";
import { UNAUTHORIZED_TEXT, allowlistMiddleware } from "./middleware/allowlist.js";
import { TelegramStatus } from "./status.js";

export const POLL_TIMEOUT_SECONDS = 30;
export const POLL_LIMIT = 100;
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** Dependencies of the feature handlers; absent in tests that only exercise the base bot. */
export interface BotHandlerDeps {
  readonly registry: Pick<ProjectRegistry, "list">;
  readonly select: SelectProjectDeps;
  readonly submit: SubmitTaskDeps;
  readonly control: SessionControlDeps;
  readonly confirmations: Pick<ConfirmationService, "answer">;
}

export interface CreateBotOptions {
  readonly token: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly chatState: ChatStateStore;
  readonly logger: Logger;
  readonly allowlistSalt?: string;
  readonly rejectionWindowMs?: number;
  readonly maxTrackedSenders?: number;
  readonly now?: () => number;
  readonly handlers?: BotHandlerDeps;
}

/**
 * Builds the bot. The allowlist is registered first, before any command (architecture §7.1), and
 * every other handler strictly after it, so an update from a sender outside the allowlist never
 * reaches a handler and causes no OpenHands call.
 *
 * Group chats: a sender must be allowlisted whatever the chat type, and state is keyed by chat id,
 * so a group has its own single active project and binding. Confirmation taps are stricter: only a
 * private chat with the tapping user may answer (see `registerConfirmationCallbacks`).
 */
export function createBot(options: CreateBotOptions): Bot<Context> {
  const bot = new Bot<Context>(options.token);
  const allowlist = allowlistMiddleware({
    allowedUserIds: options.allowedUserIds,
    logger: options.logger,
    ...(options.allowlistSalt !== undefined ? { salt: options.allowlistSalt } : {}),
    ...(options.rejectionWindowMs !== undefined ? { rejectionWindowMs: options.rejectionWindowMs } : {}),
    ...(options.maxTrackedSenders !== undefined ? { maxTrackedSenders: options.maxTrackedSenders } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  bot.use(async (ctx, next) => {
    const tap = ctx.update.callback_query;
    if (tap !== undefined && !options.allowedUserIds.has(tap.from.id)) {
      // The allowlist throttles its replies and stays silent in groups, which would leave the
      // tapper's button spinning. A callback toast is private to the tapper, so every unauthorized
      // tap is answered here, never passed on, and logged without any identifier.
      options.logger.warn("Rejected callback from a user outside the allowlist", {
        event: "telegram.callback.rejected",
      });
      try {
        await ctx.answerCallbackQuery({ text: UNAUTHORIZED_TEXT });
      } catch (error) {
        options.logger.warn("Could not deliver the unauthorized reply", {
          event: "telegram.update.reject_reply_failed",
          err_type: error instanceof Error ? error.name : typeof error,
        });
      }
      return;
    }
    await allowlist(ctx, next);
  });
  bot.catch((error) => {
    // Only the event name and the error type: the update, the error message and its cause can
    // carry user text, the bot token or request URLs.
    options.logger.error("Telegram update handler failed", {
      event: "telegram.handler_failed",
      err_type: error.error instanceof Error ? error.error.name : typeof error.error,
    });
  });
  registerStart(bot, options.chatState);
  registerHelp(bot);
  const handlers = options.handlers;
  if (handlers !== undefined) {
    const { logger } = options;
    registerProjects(bot, handlers.registry, logger);
    registerUse(bot, handlers.select, logger);
    registerStatus(bot, handlers.control, logger);
    registerPause(bot, handlers.control, logger);
    registerResume(bot, handlers.control, logger);
    registerStop(bot, handlers.control, logger);
    registerConfirmationCallbacks(bot, { confirmations: handlers.confirmations, logger });
    // Text must come after the commands: it passes any "/..." message on, never consumes it.
    registerText(bot, handlers.submit, logger);
    // Last resort: a tap that no handler recognised (stale button, old keyboard) must not spin.
    bot.on("callback_query", async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
      } catch (error) {
        logger.warn("answerCallbackQuery failed", {
          event: "telegram.callback_answer_failed",
          err_type: error instanceof Error ? error.name : typeof error,
        });
      }
    });
  }
  return bot;
}

export interface PollerOptions {
  readonly bot: Bot<Context>;
  readonly logger: Logger;
  readonly status: TelegramStatus;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

const MAX_LOGGED_MESSAGE_LENGTH = 160;

/**
 * Bounded, sanitised error text for logs: bot-token-shaped strings and control characters are
 * removed and the length is capped, so an arbitrary handler or transport error cannot leak a
 * secret or flood a log line (SEC-LOW-2).
 */
export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = Array.from(raw.replace(/\d{6,}:[A-Za-z0-9_-]{10,}/g, "<token>"), (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  }).join("");
  return cleaned.length > MAX_LOGGED_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_LOGGED_MESSAGE_LENGTH)}...`
    : cleaned;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Full-jitter exponential backoff: random in [0, min(60 s, 1 s * 2^attempt)). */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Long-polling loop over `getUpdates` (architecture §7.1). It owns offset advancement and
 * `update_id` de-duplication, and applies the 409 / 429 / network-error policies. It never
 * calls `deleteWebhook`.
 */
export class TelegramPoller {
  private readonly bot: Bot<Context>;
  private readonly logger: Logger;
  private readonly status: TelegramStatus;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  // In-memory only: a restart forgets it and Telegram may replay the last batch, so later
  // task-creating commands must be idempotent on their own (architecture §7.1).
  private lastProcessedUpdateId: number | null = null;
  private failures = 0;
  private degraded = false;

  constructor(options: PollerOptions) {
    this.bot = options.bot;
    this.logger = options.logger;
    this.status = options.status;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Polls until `signal` aborts. Never rejects for Telegram or handler errors. */
  async run(signal: AbortSignal): Promise<void> {
    // grammY types its `signal` parameter with the `abort-controller` package's AbortSignal, which
    // is structurally incompatible with the Node global one although it is used the same way.
    const apiSignal = signal as unknown as Parameters<Bot<Context>["init"]>[0];
    while (!signal.aborted) {
      try {
        await this.bot.init(apiSignal);
        const offset = this.lastProcessedUpdateId === null ? undefined : this.lastProcessedUpdateId + 1;
        const updates = await this.bot.api.getUpdates(
          {
            timeout: POLL_TIMEOUT_SECONDS,
            limit: POLL_LIMIT,
            allowed_updates: [...ALLOWED_UPDATES],
            ...(offset !== undefined ? { offset } : {}),
          },
          apiSignal,
        );
        this.markHealthy();
        for (const update of updates) {
          if (signal.aborted) {
            break;
          }
          await this.handle(update);
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        await this.recover(error, signal);
      }
    }
  }

  /** Processes one update; a duplicate or older `update_id` is a no-op. */
  async handle(update: Parameters<Bot<Context>["handleUpdate"]>[0]): Promise<void> {
    if (this.lastProcessedUpdateId !== null && update.update_id <= this.lastProcessedUpdateId) {
      return;
    }
    try {
      await this.bot.handleUpdate(update);
    } catch (error) {
      // Logged and skipped so one poison update cannot block the offset forever.
      this.logger.error("Update handler failed", {
        event: "telegram.update.failed",
        err_type: error instanceof Error ? error.name : typeof error,
        err_msg: sanitizeErrorMessage(error),
      });
    }
    this.lastProcessedUpdateId = update.update_id;
  }

  private markHealthy(): void {
    this.failures = 0;
    this.status.setConnected();
    if (this.degraded) {
      this.degraded = false;
      this.logger.info("Telegram polling recovered", { event: "telegram.poll.recovered" });
    }
  }

  private async recover(error: unknown, signal: AbortSignal): Promise<void> {
    this.degraded = true;
    const errType = error instanceof Error ? error.name : typeof error;
    const errMsg = sanitizeErrorMessage(error);
    const code = error instanceof GrammyError ? error.error_code : undefined;

    if (code === 429 && error instanceof GrammyError) {
      this.status.setDisconnected("rate_limited");
      const retryAfter = error.parameters.retry_after ?? 1;
      this.logger.warn("Telegram rate limit on getUpdates", {
        event: "telegram.poll.rate_limited",
        err_type: errType,
        duration_ms: retryAfter * 1000,
      });
      await this.sleep(retryAfter * 1000, signal);
      return;
    }

    if (code === 409) {
      this.status.setDisconnected("conflict");
      this.logger.error("getUpdates conflict: another poller or a webhook is active", {
        event: "telegram.poll.conflict",
        err_type: errType,
        err_msg: errMsg,
      });
    } else if (code === 401 || code === 404) {
      this.status.setDisconnected("unauthorized");
      this.logger.error("Telegram rejected the bot token (revoked or invalid); fix TELEGRAM_BOT_TOKEN", {
        event: "telegram.poll.unauthorized",
        err_type: errType,
        status: code,
      });
    } else {
      this.status.setDisconnected("network");
      this.logger.warn("getUpdates failed, will retry", {
        event: "telegram.poll.error",
        err_type: errType,
        err_msg: errMsg,
      });
    }
    const delay = backoffDelayMs(this.failures, this.random);
    this.failures += 1;
    await this.sleep(delay, signal);
  }
}
