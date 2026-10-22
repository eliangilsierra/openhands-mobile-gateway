import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "../../src/channels/telegram/notifier.js";
import { loadConfig, secretValues, type GatewayConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { startGateway, type RunningGateway } from "../../src/main.js";
import type { EventSubscriber } from "../../src/openhands/events-subscriber.js";
import type { openStore } from "../../src/store/db.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../mocks/openhands-server.js";
import { BOT_INFO, installFakeApi, messageUpdate, type ApiCall, type ApiResult } from "../channels/telegram/helpers.js";

/**
 * Pass-through wrappers that only record what `startGateway` creates, so shutdown can be observed
 * on the real subscriber and the real store instead of inferred from silence.
 */
const created = vi.hoisted(() => ({
  subscribers: [] as EventSubscriber[],
  stores: [] as ReturnType<typeof openStore>[],
}));

vi.mock("../../src/openhands/events-subscriber.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/openhands/events-subscriber.js")>();
  return {
    ...actual,
    createEventSubscriber: (...args: Parameters<typeof actual.createEventSubscriber>) => {
      const subscriber = actual.createEventSubscriber(...args);
      created.subscribers.push(subscriber);
      return subscriber;
    },
  };
});

vi.mock("../../src/store/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/db.js")>();
  return {
    ...actual,
    openStore: (...args: Parameters<typeof actual.openStore>) => {
      const db = actual.openStore(...args);
      created.stores.push(db);
      return db;
    },
  };
});

const API_KEY = `key-${randomUUID()}`;
const BOT_TOKEN = `123456:${randomUUID().replaceAll("-", "")}`;
const ALLOWED_ID = 4242;
const STRANGER_ID = 7777;
const CONVERSATION_ID = ["11111111", "2222", "3333", "4444", "555555555555"].join("-"); // the mock server's fixed id
const EVENTS_PATH = new RegExp(`^/api/conversations/${CONVERSATION_ID}/events/search$`);

let mock: MockOpenHandsServer;
let gateway: RunningGateway | undefined;
let lines: string[];
let queue: unknown[];
let calls: ApiCall[];

function config(): GatewayConfig {
  return {
    ...loadConfig({
      OPENHANDS_BASE_URL: mock.baseUrl,
      OPENHANDS_API_KEY: API_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ALLOWED_USER_IDS: String(ALLOWED_ID),
      DATABASE_PATH: ":memory:",
      LOG_LEVEL: "debug",
      HEALTH_PORT: "8080",
      PROJECTS: "alpha",
      EVENT_POLL_SECONDS: "1",
    }),
    healthPort: 0,
  };
}

/** One poll interval (EVENT_POLL_SECONDS=1) plus margin: a live loop would poll inside it. */
const QUIET_WINDOW_MS = 1300;
/** Boot (<=4 s of waits) + subscription wait (<=8 s) + quiet window; never the 5 s default. */
const TEST_BUDGET_MS = 20_000;

async function boot(): Promise<void> {
  const cfg = config();
  gateway = await startGateway(cfg, {
    logger: createLogger({ level: "debug", secrets: secretValues(cfg), write: (line) => lines.push(line) }),
    configureBot: (bot) => {
      calls = installFakeApi(bot, (call): ApiResult | Promise<ApiResult> => {
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
        return { ok: true, result: { message_id: 1, date: 1, chat: { id: ALLOWED_ID, type: "private" } } };
      });
    },
  });
}

async function waitFor(check: () => boolean, what: string, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sends(): ApiCall[] {
  return calls.filter((call) => call.method === "sendMessage");
}

function upstream(method: string, suffix: string): number {
  return mock.requests.filter((r) => r.method === method && r.path.endsWith(suffix)).length;
}

function stateEvent(id: string, value: string) {
  return {
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "environment",
    kind: "ConversationStateUpdateEvent",
    key: "execution_status",
    value,
  };
}

function callbackUpdate(id: number, userId: number, data: string) {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      chat_instance: "ci",
      from: { id: userId, is_bot: false, first_name: "Tester" },
      data,
      message: { message_id: 1, date: 1, chat: { id: userId, type: "private" as const, first_name: "Tester" } },
    },
  };
}

async function startTask(): Promise<void> {
  queue.push(messageUpdate(1, ALLOWED_ID, "/use alpha"), messageUpdate(2, ALLOWED_ID, "fix the bug"));
  await waitFor(() => upstream("POST", "/api/conversations") === 1, "conversation created");
}

beforeEach(async () => {
  mock = await startMockOpenHandsServer(API_KEY);
  lines = [];
  queue = [];
  calls = [];
  created.subscribers.length = 0;
  created.stores.length = 0;
});

afterEach(async () => {
  await gateway?.shutdown().catch(() => undefined);
  gateway = undefined;
  await mock.close();
  vi.restoreAllMocks();
});

describe("gateway wiring", () => {
  it("turns free text into a conversation and relays its events as plain text", async () => {
    mock.addRule({
      method: "GET",
      path: EVENTS_PATH,
      status: 200,
      body: {
        items: [
          {
            id: "a1",
            timestamp: "2026-01-01T00:00:01.000Z",
            source: "agent",
            kind: "ActionEvent",
            tool_name: "file_editor",
            action: { path: `src/token=${API_KEY}.ts` },
          },
        ],
        next_page_id: null,
      },
    });
    await boot();
    await startTask();

    await waitFor(() => sends().some((c) => String(c.payload["text"]).includes("Modificando")), "event notification");

    expect(upstream("POST", "/confirmation_policy")).toBe(1);
    const text = String(sends().find((c) => String(c.payload["text"]).includes("Modificando"))?.payload["text"]);
    expect(text).not.toContain(API_KEY);
    for (const call of calls) {
      expect(call.payload).not.toHaveProperty("parse_mode");
    }
  });

  it("shows an inline keyboard for waiting_for_confirmation and answers a tap exactly once", async () => {
    mock.addRule({
      method: "GET",
      path: EVENTS_PATH,
      status: 200,
      body: { items: [stateEvent("w1", "waiting_for_confirmation")], next_page_id: null },
    });
    await boot();
    await startTask();

    await waitFor(() => sends().some((c) => c.payload["reply_markup"] !== undefined), "prompt with keyboard");
    const prompt = sends().find((c) => c.payload["reply_markup"] !== undefined);
    const markup = prompt?.payload["reply_markup"] as { inline_keyboard: { callback_data: string }[][] };
    const approve = markup.inline_keyboard.flat().find((button) => button.callback_data.endsWith(":a"));
    expect(approve).toBeDefined();
    expect(prompt?.payload).not.toHaveProperty("parse_mode");

    queue.push(callbackUpdate(10, ALLOWED_ID, approve?.callback_data ?? ""));
    queue.push(callbackUpdate(11, ALLOWED_ID, approve?.callback_data ?? ""));
    await waitFor(
      () => calls.filter((c) => c.method === "answerCallbackQuery").length === 2,
      "both taps answered",
    );

    expect(upstream("POST", "/events/respond_to_confirmation")).toBe(1);
  });

  it("makes no OpenHands call for a stranger's task or tap", async () => {
    await boot();
    queue.push(
      messageUpdate(1, STRANGER_ID, "/use alpha"),
      messageUpdate(2, STRANGER_ID, "fix the bug"),
      callbackUpdate(3, STRANGER_ID, "c:whatever:a"),
    );
    await waitFor(() => calls.some((c) => c.method === "answerCallbackQuery"), "tap answered");

    expect(mock.requests.filter((r) => r.path.startsWith("/api/conversations"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(1);
  });

  it("fails closed when enablePolicy fails: the conversation is paused and left unbound", async () => {
    mock.addRule({ method: "POST", path: /\/confirmation_policy$/, status: 500, body: { detail: "boom" } });
    await boot();
    queue.push(messageUpdate(1, ALLOWED_ID, "/use alpha"), messageUpdate(2, ALLOWED_ID, "fix the bug"));

    await waitFor(() => upstream("POST", "/pause") >= 1, "conversation paused");
    await waitFor(() => lines.some((l) => l.includes("confirmation.policy_failed")), "failure logged");

    expect(upstream("POST", "/events")).toBe(0);
    expect(upstream("POST", "/run")).toBe(0);
    expect(lines.join("\n")).not.toContain(API_KEY);
    // Unbound: the next task creates a conversation again instead of resuming this one.
    mock.clearRules();
    queue.push(messageUpdate(3, ALLOWED_ID, "retry"));
    await waitFor(() => upstream("POST", "/api/conversations") === 2, "second conversation");
  });

  it("redacts the configured API key from the text that reaches Telegram", async () => {
    mock.addRule({
      method: "GET",
      path: EVENTS_PATH,
      status: 200,
      body: {
        items: [
          {
            id: "f1",
            timestamp: "2026-01-01T00:00:01.000Z",
            source: "agent",
            kind: "ActionEvent",
            tool_name: "finish",
            action: { message: `all done, the key was ${API_KEY}` },
          },
        ],
        next_page_id: null,
      },
    });
    await boot();
    await startTask();

    await waitFor(() => sends().some((c) => String(c.payload["text"]).includes("all done")), "finish notification");

    const text = String(sends().find((c) => String(c.payload["text"]).includes("all done"))?.payload["text"]);
    expect(text).toContain("***");
    expect(text).not.toContain(API_KEY);
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
  });

  it("closes the subscriber, stops the notifier and closes the store on shutdown", async () => {
    const stop = vi.spyOn(Notifier.prototype, "stop");
    await boot();
    await startTask();
    await waitFor(() => upstream("GET", "/events/search") >= 1, "subscription polling", 800);
    const subscriber = created.subscribers[0];
    const db = created.stores[0];
    if (subscriber === undefined || db === undefined) {
      throw new Error("the gateway did not create a subscriber and a store");
    }
    const close = vi.spyOn(subscriber, "close");
    expect(subscriber.isSubscribed(CONVERSATION_ID)).toBe(true);
    expect(() => db.prepare("SELECT 1")).not.toThrow();

    await gateway?.shutdown();
    gateway = undefined;

    expect(close).toHaveBeenCalledTimes(1);
    expect(subscriber.isSubscribed(CONVERSATION_ID)).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => db.prepare("SELECT 1")).toThrow();
    expect(lines.some((l) => l.includes('"event":"shutdown.done"'))).toBe(true);

    // No upstream traffic for more than one poll interval (EVENT_POLL_SECONDS=1): a live poll loop
    // would have asked for events again. Real time on purpose; the mock server is real too.
    const before = mock.requests.length;
    await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
    expect(mock.requests.length).toBe(before);
    // Root cause of the former flake: boot + polling waits + a 2.5 s quiet window had to fit in
    // vitest's default 5 s and did not under host load. The window is now one interval plus margin
    // and the test declares the budget of its own real-time phases explicitly.
  }, TEST_BUDGET_MS);
});
