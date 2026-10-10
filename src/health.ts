import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger.js";
import { AuthError } from "./openhands/errors.js";
import type { OpenHandsRestClient } from "./openhands/rest.js";

/**
 * `GET /health` (architecture §7.7, NFR-4, AC-15, ADR-0007 decision 4).
 *
 * The endpoint is unauthenticated and reachable on the Docker network, so the body is built only
 * from the fixed vocabulary below plus the package version and two counters. Errors from the
 * probes are mapped to a status word and are never copied into the response.
 */

export const DEFAULT_HEALTH_CACHE_SECONDS = 15;
export const DEFAULT_HEALTH_HOST = "127.0.0.1";
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

export type TelegramStatus = "connected" | "disconnected" | "unknown";
export type ApiKeyStatus = "accepted" | "rejected" | "unknown";
export type OpenHandsApiStatus = "reachable" | "unreachable";

/** Seam for the Telegram adapter: it only reports its connectivity, nothing else. */
export interface TelegramHealthSource {
  status(): TelegramStatus;
}

export interface HealthReport {
  readonly status: "ok" | "degraded";
  readonly process: "up";
  readonly sqlite: "up" | "down";
  readonly openhands_api: OpenHandsApiStatus;
  readonly telegram: TelegramStatus;
  readonly details: {
    readonly version: string;
    readonly uptime_seconds: number;
    readonly active_subscriptions: number;
    readonly last_openhands_check_age_seconds: number;
    readonly api_key: ApiKeyStatus;
  };
}

export interface HealthServiceOptions {
  readonly db: Pick<DatabaseSync, "prepare">;
  readonly client: Pick<OpenHandsRestClient, "getServerInfo" | "countConversations">;
  readonly version: string;
  /** Telegram connectivity; reported as `unknown` until the adapter provides one. */
  readonly telegram?: TelegramHealthSource;
  /** Live subscription count; stubbed at 0 until the event subscriber exists. */
  readonly activeSubscriptions?: () => number;
  /** Max age of the cached OpenHands probe result (`HEALTH_CACHE_SECONDS`). */
  readonly cacheSeconds?: number;
  /** Upper bound for one OpenHands probe round, retries included. */
  readonly probeTimeoutMs?: number;
  readonly logger?: Logger;
  /** Injectable clock (milliseconds since epoch). */
  readonly now?: () => number;
}

export interface HealthService {
  check(): Promise<HealthReport>;
}

interface OpenHandsProbe {
  readonly api: OpenHandsApiStatus;
  readonly apiKey: ApiKeyStatus;
  readonly checkedAt: number;
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("health probe timed out");
    this.name = "ProbeTimeoutError";
  }
}

/** Runs `work` with a signal that is aborted after `ms`, so the underlying request is cancelled too. */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function checkSqlite(db: Pick<DatabaseSync, "prepare">): "up" | "down" {
  try {
    db.prepare("SELECT 1").get();
    return "up";
  } catch {
    return "down";
  }
}

function readTelegram(source: TelegramHealthSource | undefined): TelegramStatus {
  if (source === undefined) {
    return "unknown";
  }
  try {
    const value = source.status();
    return value === "connected" || value === "disconnected" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

export function createHealthService(options: HealthServiceOptions): HealthService {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const cacheMs = Math.max(0, options.cacheSeconds ?? DEFAULT_HEALTH_CACHE_SECONDS) * 1000;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let cached: OpenHandsProbe | undefined;
  let inflight: Promise<OpenHandsProbe> | undefined;
  let lastStatus: HealthReport["status"] = "ok";

  async function probeApiKey(): Promise<ApiKeyStatus> {
    try {
      await withTimeout((signal) => options.client.countConversations(signal), probeTimeoutMs);
      return "accepted";
    } catch (error) {
      return error instanceof AuthError ? "rejected" : "unknown";
    }
  }

  async function probeOpenHands(): Promise<OpenHandsProbe> {
    // Both probes start together; the unauthenticated one decides "up or down" (a 401 on the
    // authenticated one never means the service is down).
    const keyProbe = probeApiKey();
    let api: OpenHandsApiStatus;
    try {
      await withTimeout((signal) => options.client.getServerInfo(signal), probeTimeoutMs);
      api = "reachable";
    } catch {
      api = "unreachable";
    }
    // `keyProbe` never rejects, so leaving it unawaited when the service is down is safe.
    const apiKey: ApiKeyStatus = api === "reachable" ? await keyProbe : "unknown";
    return { api, apiKey, checkedAt: now() };
  }

  function openHandsState(): Promise<OpenHandsProbe> {
    if (cached !== undefined && now() - cached.checkedAt < cacheMs) {
      return Promise.resolve(cached);
    }
    inflight ??= probeOpenHands()
      .then((result) => {
        cached = result;
        return result;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    async check(): Promise<HealthReport> {
      const sqlite = checkSqlite(options.db);
      const probe = await openHandsState();
      const healthy = sqlite === "up" && probe.api === "reachable" && probe.apiKey !== "rejected";
      const status = healthy ? "ok" : "degraded";
      if (status === "degraded" && lastStatus !== "degraded") {
        options.logger?.warn("Health degraded", {
          event: "health.degraded",
          sqlite,
          openhands_api: probe.api,
          api_key: probe.apiKey,
        });
      }
      if (status === "ok" && lastStatus === "degraded") {
        options.logger?.info("Health recovered", { event: "health.recovered" });
      }
      lastStatus = status;
      return {
        status,
        process: "up",
        sqlite,
        openhands_api: probe.api,
        // Informational only: never part of `healthy` (NFR-4).
        telegram: readTelegram(options.telegram),
        details: {
          version: options.version,
          uptime_seconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
          active_subscriptions: options.activeSubscriptions?.() ?? 0,
          last_openhands_check_age_seconds: Math.max(0, Math.floor((now() - probe.checkedAt) / 1000)),
          api_key: probe.apiKey,
        },
      };
    },
  };
}

/** Single-route HTTP server: `GET /health` only; everything else is 404 / 405 with no body detail. */
export function createHealthServer(service: HealthService, logger?: Logger): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/health") {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end('{"error":"not_found"}');
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, {
        "content-type": "application/json",
        "cache-control": "no-store",
        allow: "GET",
      });
      res.end('{"error":"method_not_allowed"}');
      return;
    }
    service.check().then(
      (report) => {
        res.writeHead(report.status === "ok" ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(report));
      },
      (error: unknown) => {
        logger?.error("Health check failed unexpectedly", {
          event: "health.check_failed",
          err_type: error instanceof Error ? error.name : typeof error,
        });
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"status":"degraded","process":"up"}');
      },
    );
  });
}

/**
 * Binds the server and resolves once it is listening. The host defaults to loopback (SR-2): the
 * caller must pass `0.0.0.0` explicitly to be reachable from the Docker network (§7.7). A late
 * `error` event is logged instead of crashing the process.
 */
export async function startHealthServer(
  service: HealthService,
  port: number,
  options: { readonly host?: string; readonly logger?: Logger } = {},
): Promise<Server> {
  const server = createHealthServer(service, options.logger);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? DEFAULT_HEALTH_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error: Error) => {
    options.logger?.error("Health server error", { event: "health.server_error", err_type: error.name });
  });
  options.logger?.info("Health endpoint listening", { event: "health.listening" });
  return server;
}

/** Stops accepting connections, drops idle/keep-alive ones and resolves once the server is closed. */
export function closeHealthServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
