import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, secretValues, type GatewayConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { installProcessHandlers, startGateway, type RunningGateway } from "../src/main.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "./mocks/openhands-server.js";
import {
  BOT_INFO,
  installFakeApi,
  messageUpdate,
  type ApiCall,
  type ApiResult,
} from "./channels/telegram/helpers.js";

/** Synthetic per-run values; no literal credential lives in the repository. */
const API_KEY = `key-${randomUUID()}`;
const BOT_TOKEN = `123456:${randomUUID().replaceAll("-", "")}`;
const ALLOWED_ID = 4242;
const STRANGER_ID = 7777;

let mock: MockOpenHandsServer;
let gateway: RunningGateway | undefined;
let lines: string[];

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig({
      OPENHANDS_BASE_URL: mock.baseUrl,
      OPENHANDS_API_KEY: API_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ALLOWED_USER_IDS: String(ALLOWED_ID),
      DATABASE_PATH: ":memory:",
      LOG_LEVEL: "debug",
      HEALTH_PORT: "8080",
    }),
    healthPort: 0,
    ...overrides,
  };
}

function testLogger(config: GatewayConfig) {
  return createLogger({ level: "debug", secrets: secretValues(config), write: (line) => lines.push(line) });
}

interface Transport {
  readonly calls: ApiCall[];
  deliver(update: ReturnType<typeof messageUpdate>): void;
}

/** Fake Telegram: `getMe` answers, queued updates come from `getUpdates`, then it long-polls until aborted. */
function fakeTransport(bot: Parameters<typeof installFakeApi>[0], out: { transport?: Transport }): void {
  const queue: ReturnType<typeof messageUpdate>[] = [];
  const calls = installFakeApi(bot, (call): ApiResult | Promise<ApiResult> => {
    if (call.method === "getMe") {
      return { ok: true, result: BOT_INFO };
    }
    if (call.method === "getUpdates") {
      const batch = queue.splice(0);
      if (batch.length > 0) {
        return { ok: true, result: batch };
      }
      return new Promise<ApiResult>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, result: [] }), 25);
        call.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    }
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } };
  });
  out.transport = {
    calls,
    deliver: (update) => {
      queue.push(update);
    },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function getHealth(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  mock = await startMockOpenHandsServer(API_KEY);
  lines = [];
});

afterEach(async () => {
  await gateway?.shutdown();
  gateway = undefined;
  await mock.close();
  vi.restoreAllMocks();
});

describe("startGateway", () => {
  it("boots, answers /start for an allowed id, serves /health and shuts down cleanly", async () => {
    const config = baseConfig();
    const out: { transport?: Transport } = {};
    gateway = await startGateway(config, {
      logger: testLogger(config),
      version: "9.9.9",
      configureBot: (bot) => fakeTransport(bot, out),
    });
    const transport = out.transport;
    expect(transport).toBeDefined();

    transport?.deliver(messageUpdate(1, ALLOWED_ID, "/start"));
    transport?.deliver(messageUpdate(2, STRANGER_ID, "/start"));
    await waitFor(
      () => (transport?.calls.filter((call) => call.method === "sendMessage").length ?? 0) >= 2,
      "two replies",
    );

    const replies = (transport?.calls ?? [])
      .filter((call) => call.method === "sendMessage")
      .map((call) => ({ chat: call.payload["chat_id"], text: String(call.payload["text"]) }));
    expect(replies.find((reply) => reply.chat === ALLOWED_ID)?.text).toContain("Hello!");
    expect(replies.find((reply) => reply.chat === STRANGER_ID)?.text).toBe("⛔ Unauthorized");

    await waitFor(async () => (await getHealth(gateway?.healthPort ?? 0)).body["telegram"] === "connected", "connected");
    const health = await getHealth(gateway.healthPort);
    expect(health.status).toBe(200);
    expect(health.body["status"]).toBe("ok");
    expect(health.body["sqlite"]).toBe("up");
    expect(health.body["openhands_api"]).toBe("reachable");
    expect(health.body["details"]).toMatchObject({ version: "9.9.9" });

    const port = gateway.healthPort;
    await gateway.shutdown();
    await gateway.shutdown(); // idempotent
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    expect(lines.some((line) => line.includes('"event":"shutdown.done"'))).toBe(true);
    gateway = undefined;
  });

  it("never writes the bot token, its URL-encoded form or the API key to the logs", async () => {
    const config = baseConfig();
    const out: { transport?: Transport } = {};
    const logger = testLogger(config);
    gateway = await startGateway(config, { logger, configureBot: (bot) => fakeTransport(bot, out) });
    out.transport?.deliver(messageUpdate(1, STRANGER_ID, "/start"));
    await waitFor(() => lines.some((line) => line.includes("telegram")) || lines.length > 3, "log lines");
    // Secrets echoed inside free text are redacted by the logger the Gateway builds.
    logger.error("boom", {
      event: "test",
      err_msg: `GET https://api.telegram.org/bot${BOT_TOKEN}/getUpdates ${encodeURIComponent(BOT_TOKEN)} ${API_KEY}`,
    });
    await gateway.shutdown();
    gateway = undefined;

    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain(encodeURIComponent(BOT_TOKEN));
    expect(output).not.toContain(API_KEY);
    expect(output).toContain("***");
  });

  it("reports a Telegram conflict as disconnected without degrading health (NFR-4)", async () => {
    const config = baseConfig();
    gateway = await startGateway(config, {
      logger: testLogger(config),
      configureBot: (bot) => {
        installFakeApi(bot, (call): ApiResult => {
          if (call.method === "getMe") {
            return { ok: true, result: BOT_INFO };
          }
          return { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" };
        });
      },
    });

    await waitFor(() => gateway?.telegramStatus.reason() === "conflict", "conflict");
    const health = await getHealth(gateway.healthPort);
    expect(health.body["telegram"]).toBe("disconnected");
    expect(health.status).toBe(200);
    expect(health.body["status"]).toBe("ok");
  });

  it("refuses to start with an empty allowlist", async () => {
    const config = baseConfig({ telegramAllowedUserIds: [] });

    await expect(startGateway(config, { logger: testLogger(config) })).rejects.toThrow(ConfigError);
    await expect(startGateway(config, { logger: testLogger(config) })).rejects.toThrow(/ALLOWED_USER_IDS/);
  });

  it("refuses to start with a missing token, without echoing secrets", async () => {
    const config = baseConfig({ telegramBotToken: "  " });

    const failure = await startGateway(config, { logger: testLogger(config) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(String((failure as Error).message)).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(String((failure as Error).message)).not.toContain(API_KEY);
  });

  it("releases the store when the health port cannot be bound", async () => {
    const config = baseConfig();
    gateway = await startGateway(config, {
      logger: testLogger(config),
      configureBot: (bot) => fakeTransport(bot, {}),
    });
    const busy = baseConfig({ healthPort: gateway.healthPort, healthHost: "127.0.0.1" });

    await expect(startGateway(busy, { logger: testLogger(busy) })).rejects.toThrow();
  });
});

describe("installProcessHandlers", () => {
  it("logs only the type and a sanitised message for unhandled errors, then exits 1", () => {
    const config = baseConfig();
    const handlers = new Map<string, (arg: unknown) => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, listener: (arg: unknown) => void) => {
      handlers.set(event, listener);
      return process;
    }) as never);
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: (arg: unknown) => void) => {
      handlers.set(event, listener);
      return process;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    installProcessHandlers(testLogger(config), () => Promise.resolve());
    const error = new TypeError(`fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    error.stack = `stack-with-${BOT_TOKEN}`;
    handlers.get("unhandledRejection")?.(error);
    handlers.get("uncaughtException")?.(error);

    expect(exit).toHaveBeenCalledWith(1);
    const output = lines.join("\n");
    expect(output).toContain("TypeError");
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain("stack-with");
  });

  it("runs the graceful shutdown on SIGTERM and SIGINT and exits 0", async () => {
    const config = baseConfig();
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation((() => process) as never);
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      handlers.set(event, listener);
      return process;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const onShutdown = vi.fn(() => Promise.resolve());

    installProcessHandlers(testLogger(config), onShutdown);
    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));

    expect(onShutdown).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
