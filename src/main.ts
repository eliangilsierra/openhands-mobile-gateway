import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Bot, Context } from "grammy";
import { createBot, sanitizeErrorMessage, TelegramPoller } from "./channels/telegram/bot.js";
import { TELEGRAM_CHANNEL } from "./channels/telegram/commands/start.js";
import { telegramPromptSender } from "./channels/telegram/handlers/callback.js";
import { Notifier } from "./channels/telegram/notifier.js";
import { TelegramStatus } from "./channels/telegram/status.js";
import { confirmationPromptText, ConfirmationService } from "./core/confirmations.js";
import { ProjectRegistry } from "./core/projects.js";
import { translateEvents, type Notification } from "./core/translate.js";
import { ConfigError, loadConfig, secretValues, type GatewayConfig } from "./config.js";
import { closeHealthServer, createHealthService, startHealthServer } from "./health.js";
import { createLogger, type Logger } from "./logger.js";
import { createEventSubscriber, type EventSubscriber, type OpenHandsEvent } from "./openhands/events-subscriber.js";
import { createOpenHandsRestClient, type OpenHandsRestClient } from "./openhands/rest.js";
import { ChatStateRepository } from "./store/chat-state.js";
import { ConversationBindingRepository } from "./store/conversation-binding.js";
import { closeStore, openStore } from "./store/db.js";
import { EventCursorRepository } from "./store/event-cursor.js";
import { PendingConfirmationRepository } from "./store/pending-confirmation.js";
import { scheduleRetention } from "./store/retention.js";
import { SeenEventRepository } from "./store/seen-event.js";
import { runInTransaction } from "./store/transaction.js";

/**
 * Process entry point (architecture §10): loads and validates configuration, builds the
 * structured logger, opens the SQLite store (running migrations), composes the Telegram bot and
 * poller with the `/health` server, and shuts everything down on SIGTERM / SIGINT.
 *
 * Health policy (NFR-4 wins over the older wording of architecture §7.2/§9): Telegram connectivity
 * is reported in `/health` as informational (`telegram: connected|disconnected`) but never turns
 * `status` to `degraded`, so a Telegram 409 conflict does not make Docker restart the container.
 * The operator learns about 409 / 401 from the `telegram.poll.conflict` /
 * `telegram.poll.unauthorized` log events (README runbook). The same holds for a WebSocket 4001.
 */

/** Docker's default stop grace is 10 s; leave headroom for the final log lines and exit. */
export const SHUTDOWN_DEADLINE_MS = 8_000;

/**
 * Emits a single JSON log line and exits non-zero when configuration validation fails.
 * Built only from {@link ConfigError.message}, which never contains a raw environment value
 * (architecture §9.1 B4) — so this failure path cannot leak a secret either.
 */
export function reportConfigFailure(error: ConfigError): never {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    msg: "Gateway failed to start: invalid configuration",
    event: "boot.config_failed",
    err_type: error.name,
    err_msg: error.message,
  });
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

/** Installs SIGTERM / SIGINT / unhandledRejection / uncaughtException handlers (architecture §10). */
export function installProcessHandlers(logger: Logger, onShutdown: () => Promise<void>): void {
  const shutdownOn = (signal: "SIGTERM" | "SIGINT"): void => {
    logger.info(`Received ${signal}, shutting down`, { event: `shutdown.${signal.toLowerCase()}` });
    onShutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("Shutdown failed", {
          event: "shutdown.failed",
          err_type: error instanceof Error ? error.name : typeof error,
          err_msg: sanitizeErrorMessage(error),
        });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdownOn("SIGTERM"));
  process.once("SIGINT", () => shutdownOn("SIGINT"));

  // Only the error type and a sanitised, bounded message are logged: never the error object, its
  // stack or its properties, which can carry request URLs or tokens.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection", {
      event: "process.unhandled_rejection",
      err_type: reason instanceof Error ? reason.name : typeof reason,
      err_msg: sanitizeErrorMessage(reason),
    });
    process.exit(1);
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception", {
      event: "process.uncaught_exception",
      err_type: error.name,
      err_msg: sanitizeErrorMessage(error),
    });
    process.exit(1);
  });
}

export function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const { version } = parsed;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  } catch {
    // Health must not depend on the package file being present.
  }
  return "unknown";
}

/** Test seams for {@link startGateway}; production passes none. */
export interface StartGatewayOptions {
  readonly logger?: Logger;
  readonly version?: string;
  /** Shutdown deadline in ms; defaults to {@link SHUTDOWN_DEADLINE_MS}. */
  readonly shutdownDeadlineMs?: number;
  /** Called with the bot before polling starts, so tests can replace the Telegram transport. */
  readonly configureBot?: (bot: Bot<Context>) => void;
  /** Interval of the retention job in ms; defaults to one hour. */
  readonly retentionIntervalMs?: number;
}

export interface RunningGateway {
  /** Port `/health` is bound to (differs from the configured one when that is 0). */
  readonly healthPort: number;
  readonly telegramStatus: TelegramStatus;
  /** Idempotent graceful shutdown: stops polling, then the health server, then the store. */
  shutdown(): Promise<void>;
}

/** Rejects (so the process exits non-zero) when graceful shutdown does not finish in time. */
class ShutdownTimeoutError extends Error {
  constructor() {
    super("Shutdown deadline exceeded; resources may still be open");
    this.name = "ShutdownTimeoutError";
  }
}

function withDeadline(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new ShutdownTimeoutError());
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Shutdown callback for the signal handlers; a signal before startup completes is a no-op. */
export function createShutdownHandler(getGateway: () => RunningGateway | undefined): () => Promise<void> {
  return async () => {
    await getGateway()?.shutdown();
  };
}

/** Replaces every configured secret and any bot-token-shaped string before text leaves the Gateway. */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const ordered = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of ordered) {
      out = out.split(secret).join("***");
    }
    return out.replace(/\d{6,}:[A-Za-z0-9_-]{10,}/g, "***");
  };
}

/** Raised when a new conversation could not be put in confirmation mode: it must not run unconfirmed. */
export class ConfirmationPolicyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Could not enable the confirmation policy; the conversation was paused", options);
    this.name = "ConfirmationPolicyError";
  }
}

/**
 * Fail-closed wrapper (item 5): a conversation is put in confirmation mode right after it is
 * created. If that fails, the conversation is paused (best effort), the error propagates so the
 * session reports a failure and never binds or activates it.
 * `createConversation` has no policy field in `CreateConversationRequest` (outside this task's
 * Touches), so a short window between creation and the policy call remains: see the PR follow-ups.
 */
export function withConfirmationPolicy(
  client: OpenHandsRestClient,
  confirmations: Pick<ConfirmationService, "enablePolicy">,
  logger: Logger,
): Pick<OpenHandsRestClient, "createConversation" | "sendEvent"> {
  return {
    sendEvent: (id, request) => client.sendEvent(id, request),
    createConversation: async (request) => {
      const info = await client.createConversation(request);
      try {
        await confirmations.enablePolicy(info.id);
      } catch (error) {
        logger.error("Confirmation policy could not be enabled; pausing the conversation", {
          event: "confirmation.policy_failed",
          conversation_id: info.id,
          err_type: error instanceof Error ? error.name : typeof error,
        });
        try {
          await client.pauseConversation(info.id);
        } catch (pauseError) {
          logger.error("Could not pause the unconfirmed conversation", {
            event: "confirmation.policy_pause_failed",
            conversation_id: info.id,
            err_type: pauseError instanceof Error ? pauseError.name : typeof pauseError,
          });
        }
        throw new ConfirmationPolicyError({ cause: error });
      }
      return info;
    },
  };
}

const MAX_TRACKED_CONVERSATIONS = 1000;
export const AUTH_FAILED_TEXT = "⚠️ La clave de API de OpenHands no es válida. Avisa al operador.";

function isWaitingForConfirmation(event: OpenHandsEvent): boolean {
  return (
    event.kind === "ConversationStateUpdateEvent" &&
    event["key"] === "execution_status" &&
    event["value"] === "waiting_for_confirmation"
  );
}

export interface EventPipelineOptions {
  readonly bindings: Pick<ConversationBindingRepository, "findByConversationId">;
  readonly confirmations: Pick<ConfirmationService, "request">;
  readonly notifier: Pick<Notifier, "enqueue">;
  readonly api: Parameters<typeof telegramPromptSender>[0];
  readonly redact: (text: string) => string;
  readonly logger: Logger;
  /** Set after the subscriber exists (the subscriber's own options never need the pipeline). */
  readonly setTerminal: (conversationId: string, terminal: boolean) => void;
  readonly unsubscribe: (conversationId: string) => void;
}

export interface EventPipeline {
  /** Event handler for one conversation: translate -> redact -> notifier (or confirmation prompt). */
  handlerFor(conversationId: string): (event: OpenHandsEvent) => Promise<void>;
  /** `onAuthFailed` of the subscriber: tells the chat once that the API key was rejected. */
  authFailed(conversationId: string): void;
}

/**
 * Subscriber -> translator -> redact -> notifier, plus the confirmation prompt for
 * `waiting_for_confirmation`. The chat id comes from the conversation's binding. Every translated
 * notification is sent as `contentKind: "text"`: the translator only emits short plain-text
 * summaries, and no producer of `log` / `diff` bodies exists yet (they would be redacted here too).
 */
export function createEventPipeline(options: EventPipelineOptions): EventPipeline {
  const lastByConversation = new Map<string, Notification>();

  const chatOf = (conversationId: string): string | null => {
    const binding = options.bindings.findByConversationId(conversationId);
    if (binding === null || binding.channel !== TELEGRAM_CHANNEL) {
      return null;
    }
    if (binding.state !== "active") {
      // A stale or closed binding no longer owns the conversation: stop listening to it.
      options.unsubscribe(conversationId);
      return null;
    }
    return binding.externalChatId;
  };

  const remember = (conversationId: string, notification: Notification | undefined): void => {
    if (notification === undefined || notification.terminal) {
      lastByConversation.delete(conversationId);
      return;
    }
    lastByConversation.delete(conversationId);
    lastByConversation.set(conversationId, notification);
    if (lastByConversation.size > MAX_TRACKED_CONVERSATIONS) {
      const oldest = lastByConversation.keys().next();
      if (oldest.done !== true) {
        lastByConversation.delete(oldest.value);
      }
    }
  };

  const enqueue = (chatId: string, conversationId: string, notification: Notification): void => {
    options.notifier.enqueue({
      chatId,
      conversationId,
      notification: { ...notification, text: options.redact(notification.text) },
      contentKind: "text",
    });
  };

  const handle = async (conversationId: string, event: OpenHandsEvent): Promise<void> => {
    const chatId = chatOf(conversationId);
    if (chatId === null) {
      return;
    }
    // The translator requires `source`; the subscriber leaves it optional.
    const translatable = { ...event, source: event.source ?? "" };
    let notifications = translateEvents([translatable], lastByConversation.get(conversationId));
    if (isWaitingForConfirmation(event)) {
      const result = await options.confirmations.request(
        { conversationId, actionEventId: event.id, channel: TELEGRAM_CHANNEL, externalChatId: chatId },
        telegramPromptSender(options.api, chatId, options.redact(confirmationPromptText(translatable))),
      );
      if (result.status !== "send_failed") {
        // The prompt (with its keyboard) already says it; a second plain notice would be noise.
        notifications = notifications.filter((notification) => notification.category !== "waiting");
      }
    }
    for (const notification of notifications) {
      enqueue(chatId, conversationId, notification);
      if (notification.terminal) {
        options.setTerminal(conversationId, true);
      }
    }
    remember(conversationId, notifications.at(-1) ?? lastByConversation.get(conversationId));
  };

  return {
    handlerFor: (conversationId) => async (event) => {
      try {
        await handle(conversationId, event);
      } catch (error) {
        // One bad event must not stop the stream: log the type only and carry on.
        options.logger.error("Event handling failed", {
          event: "pipeline.event_failed",
          conversation_id: conversationId,
          err_type: error instanceof Error ? error.name : typeof error,
        });
      }
    },
    authFailed: (conversationId) => {
      try {
        const chatId = chatOf(conversationId);
        if (chatId !== null) {
          enqueue(chatId, conversationId, {
            text: AUTH_FAILED_TEXT,
            category: "failed",
            severity: "error",
            terminal: true,
          });
        }
      } catch (error) {
        options.logger.error("Could not report the API key failure", {
          event: "pipeline.auth_notice_failed",
          conversation_id: conversationId,
          err_type: error instanceof Error ? error.name : typeof error,
        });
      }
    },
  };
}

/**
 * Composes and starts the Gateway from an already validated config. Throws (after releasing
 * whatever it opened) on an empty allowlist, a missing token, a corrupt store or a busy health port.
 */
export async function startGateway(
  config: GatewayConfig,
  options: StartGatewayOptions = {},
): Promise<RunningGateway> {
  // Defensive repeat of the config.ts checks: an empty allowlist must never start a bot.
  if (config.telegramBotToken.trim().length === 0) {
    throw new ConfigError("Invalid configuration: TELEGRAM_BOT_TOKEN must not be empty");
  }
  const allowedUserIds: ReadonlySet<number> = new Set(config.telegramAllowedUserIds);
  if (allowedUserIds.size === 0) {
    throw new ConfigError("Invalid configuration: TELEGRAM_ALLOWED_USER_IDS must list at least one id");
  }

  const logger = options.logger ?? createLogger({ level: config.logLevel, secrets: secretValues(config) });
  if (!isLoopbackHost(config.healthHost)) {
    logger.warn("Health server is bound to a non-loopback address; /health is reachable from the network", {
      event: "health.non_loopback_host",
    });
  }
  const db = openStore({ databasePath: config.databasePath, logger });
  const telegramStatus = new TelegramStatus();
  const redact = createRedactor(secretValues(config));
  const activated = new Set<string>();
  let bot: Bot<Context> | undefined;
  let notifier: Notifier | undefined;
  let subscriber: EventSubscriber | undefined;
  let server: Awaited<ReturnType<typeof startHealthServer>>;
  let stopRetention: (() => void) | undefined;
  try {
    const client = createOpenHandsRestClient({
      baseUrl: config.openhandsBaseUrl,
      apiKey: config.openhandsApiKey,
      logger,
    });
    const chatState = new ChatStateRepository(db, logger);
    const bindings = new ConversationBindingRepository(db, logger);
    const pendingConfirmations = new PendingConfirmationRepository(db, logger);
    const seenEvents = new SeenEventRepository(db, logger);
    const confirmations = new ConfirmationService({
      store: pendingConfirmations,
      client,
      logger,
    });
    const registry = new ProjectRegistry({
      projectsRoot: config.projectsRoot,
      staticProjects: config.projects,
      client,
      logger,
    });
    // Late-bound: handlers are registered inside `createBot` (after the allowlist) but need the
    // subscriber, which needs the notifier, which needs the bot's api.
    const holder: { subscriber?: EventSubscriber; pipeline?: EventPipeline } = {};
    const activate = (conversationId: string): void => {
      const { subscriber: current, pipeline } = holder;
      if (current === undefined || pipeline === undefined) {
        return;
      }
      activated.add(conversationId);
      current.subscribe(conversationId, pipeline.handlerFor(conversationId));
    };
    // No `allowlistSalt` (a random per-process salt is used) and no request / sensitive logging
    // on the Bot: nothing here may put a user id or the token in a log line.
    const newBot = createBot({
      token: config.telegramBotToken,
      allowedUserIds,
      chatState,
      logger,
      handlers: {
        registry,
        select: { registry, chatState, bindings },
        submit: {
          registry,
          chatState,
          bindings,
          client: withConfirmationPolicy(client, confirmations, logger),
          logger,
          activate,
          maxTaskChars: config.maxTaskChars,
        },
        control: {
          chatState,
          bindings,
          client,
          logger,
          setTerminal: (id, terminal) => holder.subscriber?.setTerminal(id, terminal),
        },
        confirmations,
      },
    });
    bot = newBot;
    const newNotifier = new Notifier({ api: newBot.api, logger });
    notifier = newNotifier;
    const pipeline = createEventPipeline({
      bindings,
      confirmations,
      notifier: newNotifier,
      api: newBot.api,
      redact,
      logger,
      setTerminal: (id, terminal) => holder.subscriber?.setTerminal(id, terminal),
      unsubscribe: (id) => holder.subscriber?.unsubscribe(id),
    });
    const newSubscriber = createEventSubscriber({
      baseUrl: config.openhandsBaseUrl,
      apiKey: config.openhandsApiKey,
      cursors: new EventCursorRepository(db, logger),
      seen: seenEvents,
      transaction: (fn) => runInTransaction(db, logger, fn),
      client,
      logger,
      eventPollSeconds: config.eventPollSeconds,
      wsIdleSeconds: config.wsIdleSeconds,
      onHealthSignal: (signal) => {
        logger.debug("Event subscriber health signal", {
          event: "subscriber.health_signal",
          ...(signal.openhandsApi !== undefined ? { openhands_api: signal.openhandsApi } : {}),
          ...(signal.keyStatus !== undefined ? { api_key: signal.keyStatus } : {}),
        });
      },
      onAuthFailed: (conversationId) => pipeline.authFailed(conversationId),
    });
    subscriber = newSubscriber;
    holder.subscriber = newSubscriber;
    holder.pipeline = pipeline;
    options.configureBot?.(newBot);

    const health = createHealthService({
      db,
      client,
      version: options.version ?? readPackageVersion(),
      telegram: { status: () => telegramStatus.get() },
      activeSubscriptions: () => {
        for (const id of activated) {
          if (!newSubscriber.isSubscribed(id)) {
            activated.delete(id);
          }
        }
        return activated.size;
      },
      cacheSeconds: config.healthCacheSeconds,
      logger,
    });
    server = await startHealthServer(health, config.healthPort, { host: config.healthHost, logger });
    // Last step of startup, so a failed start never leaves a timer behind: prunes now and hourly.
    stopRetention = scheduleRetention(
      {
        bindings,
        confirmations: pendingConfirmations,
        seen: seenEvents,
        logger,
        retentionDays: config.retentionDays,
      },
      options.retentionIntervalMs,
    );
  } catch (error) {
    subscriber?.close();
    notifier?.stop();
    closeStore(db);
    throw error;
  }
  const runningBot = bot;
  const runningNotifier = notifier;
  const runningSubscriber = subscriber;

  const abort = new AbortController();
  const polling = new TelegramPoller({ bot: runningBot, logger, status: telegramStatus }).run(abort.signal);
  logger.info("Gateway started", { event: "boot.started" });

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= withDeadline(
      (async () => {
        stopRetention?.();
        abort.abort();
        await polling;
        runningSubscriber.close();
        runningNotifier.stop();
        await closeHealthServer(server);
        closeStore(db);
        logger.info("Gateway stopped", { event: "shutdown.done" });
      })(),
      options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS,
      () => {
        logger.error("Shutdown deadline exceeded", { event: "shutdown.deadline_exceeded" });
      },
    );
    return stopping;
  };

  return { healthPort: (server.address() as AddressInfo).port, telegramStatus, shutdown };
}

export async function main(): Promise<void> {
  let config: GatewayConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      reportConfigFailure(error);
    }
    throw error;
  }

  // Built from every secret in the config: the bot token (also URL-encoded) and the API key.
  const logger = createLogger({ level: config.logLevel, secrets: secretValues(config) });
  let gateway: RunningGateway | undefined;
  installProcessHandlers(logger, createShutdownHandler(() => gateway));
  logger.info("Gateway configuration loaded", { event: "boot.config_ok" });

  try {
    gateway = await startGateway(config, { logger });
  } catch (error) {
    logger.error("Gateway failed to start", {
      event: "boot.failed",
      err_type: error instanceof Error ? error.name : typeof error,
      err_msg: sanitizeErrorMessage(error),
    });
    process.exit(1);
  }
}

const entryPath = process.argv[1];
const isMainModule = entryPath !== undefined && import.meta.url === new URL(entryPath, "file://").href;

if (isMainModule) {
  void main();
}
