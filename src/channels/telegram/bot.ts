import { Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import type { Logger } from "../../logger.js";
import { registerHelp } from "./commands/help.js";
import { registerStart, type ChatStateStore } from "./commands/start.js";
import { allowlistMiddleware } from "./middleware/allowlist.js";
import { TelegramStatus } from "./status.js";

export const POLL_TIMEOUT_SECONDS = 30;
export const POLL_LIMIT = 100;
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface CreateBotOptions {
  readonly token: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly chatState: ChatStateStore;
  readonly logger: Logger;
  readonly allowlistSalt?: string;
}

/**
 * Builds the bot. The allowlist is registered first, before any command (architecture §7.1).
 * Later work packages register their own handlers on the returned instance.
 */
export function createBot(options: CreateBotOptions): Bot<Context> {
  const bot = new Bot<Context>(options.token);
  bot.use(
    allowlistMiddleware({
      allowedUserIds: options.allowedUserIds,
      logger: options.logger,
      ...(options.allowlistSalt !== undefined ? { salt: options.allowlistSalt } : {}),
    }),
  );
  registerStart(bot, options.chatState);
  registerHelp(bot);
  return bot;
}

export interface PollerOptions {
  readonly bot: Bot<Context>;
  readonly logger: Logger;
  readonly status: TelegramStatus;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
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
  private lastProcessedUpdateId: number | null = null;
  private failures = 0;

  constructor(options: PollerOptions) {
    this.bot = options.bot;
    this.logger = options.logger;
    this.status = options.status;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Polls until `signal` aborts. Never rejects for Telegram or handler errors. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.bot.init();
        const offset = this.lastProcessedUpdateId === null ? undefined : this.lastProcessedUpdateId + 1;
        // The in-flight long poll ends on its own within POLL_TIMEOUT_SECONDS after an abort.
        const updates = await this.bot.api.getUpdates({
          timeout: POLL_TIMEOUT_SECONDS,
          limit: POLL_LIMIT,
          allowed_updates: [...ALLOWED_UPDATES],
          ...(offset !== undefined ? { offset } : {}),
        });
        this.failures = 0;
        this.status.set("connected");
        for (const update of updates) {
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
        err_msg: error instanceof Error ? error.message : String(error),
      });
    }
    this.lastProcessedUpdateId = update.update_id;
  }

  private async recover(error: unknown, signal: AbortSignal): Promise<void> {
    this.status.set("disconnected");
    const errType = error instanceof Error ? error.name : typeof error;
    const errMsg = error instanceof Error ? error.message : String(error);

    if (error instanceof GrammyError && error.error_code === 429) {
      const retryAfter = error.parameters.retry_after ?? 1;
      this.logger.warn("Telegram rate limit on getUpdates", {
        event: "telegram.poll.rate_limited",
        err_type: errType,
        duration_ms: retryAfter * 1000,
      });
      await this.sleep(retryAfter * 1000, signal);
      return;
    }

    if (error instanceof GrammyError && error.error_code === 409) {
      this.logger.error("getUpdates conflict: another poller or a webhook is active", {
        event: "telegram.poll.conflict",
        err_type: errType,
        err_msg: errMsg,
      });
    } else {
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
