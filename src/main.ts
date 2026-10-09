import { ConfigError, loadConfig, secretValues } from "./config.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * Process entry point stub (architecture §10).
 *
 * Loads and validates configuration, builds the structured logger, and installs the
 * process-level signal/error handlers. No channel or OpenHands logic lives here yet — later
 * work packages wire the Telegram poller, the OpenHands client and the SQLite store into this
 * boot sequence.
 */

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

/** Installs SIGTERM / unhandledRejection / uncaughtException handlers (architecture §10). */
export function installProcessHandlers(logger: Logger): void {
  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down", { event: "shutdown.sigterm" });
    // Later tasks stop polling, drain the per-chat send queues and close SQLite here.
    process.exit(0);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection", {
      event: "process.unhandled_rejection",
      err_type: reason instanceof Error ? reason.name : typeof reason,
      err_msg: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception", {
      event: "process.uncaught_exception",
      err_type: error.name,
      err_msg: error.message,
    });
    process.exit(1);
  });
}

export function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      reportConfigFailure(error);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel, secrets: secretValues(config) });
  installProcessHandlers(logger);

  logger.info("Gateway configuration loaded", { event: "boot.config_ok" });
}

const entryPath = process.argv[1];
const isMainModule = entryPath !== undefined && import.meta.url === new URL(entryPath, "file://").href;

if (isMainModule) {
  main();
}
