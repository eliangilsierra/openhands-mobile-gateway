import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Bot, Context } from "grammy";
import { createBot, sanitizeErrorMessage, TelegramPoller } from "./channels/telegram/bot.js";
import { TelegramStatus } from "./channels/telegram/status.js";
import { ConfigError, loadConfig, secretValues, type GatewayConfig } from "./config.js";
import { closeHealthServer, createHealthService, startHealthServer } from "./health.js";
import { createLogger, type Logger } from "./logger.js";
import { createOpenHandsRestClient } from "./openhands/rest.js";
import { ChatStateRepository } from "./store/chat-state.js";
import { closeStore, openStore } from "./store/db.js";

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
  /** Called with the bot before polling starts, so tests can replace the Telegram transport. */
  readonly configureBot?: (bot: Bot<Context>) => void;
}

export interface RunningGateway {
  /** Port `/health` is bound to (differs from the configured one when that is 0). */
  readonly healthPort: number;
  readonly telegramStatus: TelegramStatus;
  /** Idempotent graceful shutdown: stops polling, then the health server, then the store. */
  shutdown(): Promise<void>;
}

function withDeadline(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
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
  const db = openStore({ databasePath: config.databasePath, logger });
  const telegramStatus = new TelegramStatus();
  let bot: Bot<Context>;
  let server: Awaited<ReturnType<typeof startHealthServer>>;
  try {
    const client = createOpenHandsRestClient({
      baseUrl: config.openhandsBaseUrl,
      apiKey: config.openhandsApiKey,
      logger,
    });
    // No `allowlistSalt` (a random per-process salt is used) and no request / sensitive logging
    // on the Bot: nothing here may put a user id or the token in a log line.
    bot = createBot({
      token: config.telegramBotToken,
      allowedUserIds,
      chatState: new ChatStateRepository(db, logger),
      logger,
    });
    options.configureBot?.(bot);

    const health = createHealthService({
      db,
      client,
      version: options.version ?? readPackageVersion(),
      telegram: { status: () => telegramStatus.get() },
      cacheSeconds: config.healthCacheSeconds,
      logger,
    });
    server = await startHealthServer(health, config.healthPort, { host: config.healthHost, logger });
  } catch (error) {
    closeStore(db);
    throw error;
  }

  const abort = new AbortController();
  const polling = new TelegramPoller({ bot, logger, status: telegramStatus }).run(abort.signal);
  logger.info("Gateway started", { event: "boot.started" });

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= withDeadline(
      (async () => {
        abort.abort();
        await polling;
        await closeHealthServer(server);
        closeStore(db);
        logger.info("Gateway stopped", { event: "shutdown.done" });
      })(),
      SHUTDOWN_DEADLINE_MS,
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
  installProcessHandlers(logger, async () => {
    await gateway?.shutdown();
  });
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
