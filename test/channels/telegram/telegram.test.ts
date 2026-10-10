import { HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_UPDATES,
  backoffDelayMs,
  createBot,
  POLL_LIMIT,
  POLL_TIMEOUT_SECONDS,
  TelegramPoller,
} from "../../../src/channels/telegram/bot.js";
import { HELP_TEXT } from "../../../src/channels/telegram/commands/help.js";
import { hashUserId, UNAUTHORIZED_TEXT } from "../../../src/channels/telegram/middleware/allowlist.js";
import { TelegramStatus } from "../../../src/channels/telegram/status.js";
import { ChatStateRepository } from "../../../src/store/chat-state.js";
import { closeStore, openStore } from "../../../src/store/db.js";
import { createRecordingLogger, createTempDbPath } from "../../store/helpers.js";
import { BOT_INFO, installFakeApi, messageUpdate, type ApiCall, type ApiResult } from "./helpers.js";
import type { DatabaseSync } from "node:sqlite";

const ALLOWED = 1001;
const STRANGER = 9999;
const TOKEN = "123456:TEST-TOKEN-NOT-REAL";
const SALT = "test-salt";

let db: DatabaseSync;
let cleanup: () => void;
let logger: ReturnType<typeof createRecordingLogger>;
let chatState: ChatStateRepository;

beforeEach(() => {
  const temp = createTempDbPath();
  cleanup = temp.cleanup;
  logger = createRecordingLogger();
  db = openStore({ databasePath: temp.path, logger });
  chatState = new ChatStateRepository(db, logger);
});

afterEach(() => {
  closeStore(db);
  cleanup();
});

function build(respond?: (call: ApiCall) => ApiResult) {
  const bot = createBot({
    token: TOKEN,
    allowedUserIds: new Set([ALLOWED]),
    chatState,
    logger,
    allowlistSalt: SALT,
  });
  bot.botInfo = BOT_INFO;
  const calls = installFakeApi(bot, respond ?? (() => ({ ok: true, result: true })));
  const status = new TelegramStatus();
  const sleeps: number[] = [];
  const poller = new TelegramPoller({
    bot,
    logger,
    status,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
  return { bot, calls, status, sleeps, poller };
}

const sends = (calls: ApiCall[]) => calls.filter((c) => c.method === "sendMessage");

describe("allowlist middleware", () => {
  it("T-AC-1: rejects an unauthorized /start with the exact text and creates no chat row", async () => {
    const { poller, calls } = build();
    await poller.handle(messageUpdate(1, STRANGER, "/start"));

    expect(sends(calls)).toHaveLength(1);
    expect(sends(calls)[0]?.payload["text"]).toBe(UNAUTHORIZED_TEXT);
    expect(chatState.find("telegram", String(STRANGER))).toBeNull();

    const rejected = logger.records.filter((r) => r.fields?.["event"] === "telegram.update.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.fields?.["chat_ref"]).toBe(hashUserId(STRANGER, SALT));
    expect(JSON.stringify(logger.records)).not.toContain(String(STRANGER));
  });

  it("T-AC-2: identical reply and log for every kind of rejected input", async () => {
    const { poller, calls } = build();
    const inputs = ["/start", "/help", "/nonexistent", "hello", "/use secret-project"];
    for (const [i, text] of inputs.entries()) {
      await poller.handle(messageUpdate(i + 1, STRANGER, text));
    }
    const texts = sends(calls).map((c) => c.payload["text"]);
    expect(texts).toEqual(inputs.map(() => UNAUTHORIZED_TEXT));

    const rejected = logger.records.filter((r) => r.fields?.["event"] === "telegram.update.rejected");
    expect(rejected).toHaveLength(inputs.length);
    expect(new Set(rejected.map((r) => JSON.stringify(r)))).toHaveProperty("size", 1);
    expect(JSON.stringify(logger.records)).not.toContain("secret-project");
  });

  it("answers an unauthorized callback_query with the same text and nothing else", async () => {
    const { poller, calls } = build();
    await poller.handle({
      update_id: 5,
      callback_query: {
        id: "cb1",
        chat_instance: "ci",
        from: { id: STRANGER, is_bot: false, first_name: "X" },
        data: "x",
      },
    });
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    expect(calls[0]?.payload["text"]).toBe(UNAUTHORIZED_TEXT);
  });

  it("rejects update kinds outside message/callback_query, even from an allowed user", async () => {
    const { poller, calls } = build();
    await poller.handle({ update_id: 6, edited_message: messageUpdate(6, ALLOWED, "x").message! });
    expect(sends(calls)[0]?.payload["text"]).toBe(UNAUTHORIZED_TEXT);
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.update.rejected")).toBe(true);
  });

  it("still logs and does not throw when the rejection reply fails", async () => {
    const { poller } = build(() => ({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" }));
    await expect(poller.handle(messageUpdate(1, STRANGER, "hi"))).resolves.toBeUndefined();
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.update.reject_reply_failed")).toBe(true);
  });

  it("hashes differ per salt and never contain the raw id", () => {
    expect(hashUserId(42, "a")).not.toBe(hashUserId(42, "b"));
    expect(hashUserId(42, "a")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("commands", () => {
  it("T-AC-3: /start for an allowed user creates the chat row and greets with /help", async () => {
    const { poller, calls } = build();
    await poller.handle(messageUpdate(1, ALLOWED, "/start"));

    expect(chatState.find("telegram", String(ALLOWED))).not.toBeNull();
    const text = String(sends(calls)[0]?.payload["text"]);
    expect(text).toContain("Hello");
    expect(text).toContain("/help");
  });

  it("/start keeps an already selected project", async () => {
    chatState.setActiveProject("telegram", String(ALLOWED), "demo");
    const { poller, calls } = build();
    await poller.handle(messageUpdate(1, ALLOWED, "/start"));
    expect(chatState.getActiveProject("telegram", String(ALLOWED))).toBe("demo");
    expect(String(sends(calls)[0]?.payload["text"])).toContain("demo");
  });

  it("/help returns the static list", async () => {
    const { poller, calls } = build();
    await poller.handle(messageUpdate(1, ALLOWED, "/help"));
    expect(sends(calls)[0]?.payload["text"]).toBe(HELP_TEXT);
    expect(chatState.find("telegram", String(ALLOWED))).toBeNull();
  });
});

describe("poller", () => {
  it("T-AC-5: a duplicate update_id is a no-op", async () => {
    const { poller, calls } = build();
    const update = messageUpdate(10, ALLOWED, "/start");
    await poller.handle(update);
    await poller.handle(update);
    expect(sends(calls)).toHaveLength(1);
  });

  it("polls with the contracted parameters and advances offset after handling", async () => {
    const ac = new AbortController();
    let polls = 0;
    const { poller, calls } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls === 1) return { ok: true, result: [messageUpdate(20, ALLOWED, "/help"), messageUpdate(21, ALLOWED, "/help")] };
      ac.abort();
      return { ok: true, result: [] };
    });
    await poller.run(ac.signal);

    const gets = calls.filter((c) => c.method === "getUpdates");
    expect(gets[0]?.payload).toMatchObject({
      timeout: POLL_TIMEOUT_SECONDS,
      limit: POLL_LIMIT,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    expect(gets[0]?.payload["offset"]).toBeUndefined();
    expect(gets[1]?.payload["offset"]).toBe(22);
    expect(sends(calls)).toHaveLength(2);
  });

  it("T-AC-4: 409 logs ERROR, reports disconnected, retries and never calls deleteWebhook", async () => {
    const ac = new AbortController();
    let polls = 0;
    const { poller, calls, status, sleeps } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls <= 2) return { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" };
      ac.abort();
      return { ok: true, result: [] };
    });
    await poller.run(ac.signal);

    const errors = logger.records.filter((r) => r.level === "error" && r.fields?.["event"] === "telegram.poll.conflict");
    expect(errors).toHaveLength(2);
    expect(calls.some((c) => c.method === "deleteWebhook")).toBe(false);
    expect(sleeps).toEqual([500, 1000]);
    expect(status.get()).toBe("connected");
  });

  it("409 leaves the status disconnected while the conflict lasts", async () => {
    const ac = new AbortController();
    const { poller, status } = build((call) => {
      if (call.method === "getUpdates") {
        queueMicrotask(() => ac.abort());
        return { ok: false, error_code: 409, description: "Conflict" };
      }
      return { ok: true, result: true };
    });
    await poller.run(ac.signal);
    expect(status.get()).toBe("disconnected");
  });

  it("429 honours retry_after", async () => {
    const ac = new AbortController();
    let polls = 0;
    const { poller, sleeps } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls === 1) return { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } };
      ac.abort();
      return { ok: true, result: [] };
    });
    await poller.run(ac.signal);
    expect(sleeps).toEqual([7000]);
  });

  it("network errors back off exponentially with full jitter and reset on success", async () => {
    const ac = new AbortController();
    let polls = 0;
    const bot = createBot({ token: TOKEN, allowedUserIds: new Set([ALLOWED]), chatState, logger });
    bot.botInfo = BOT_INFO;
    installFakeApi(bot, (call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls <= 3) throw new HttpError("Network request for 'getUpdates' failed!", new Error("ECONNRESET"));
      if (polls === 4) return { ok: true, result: [] };
      if (polls === 5) throw new HttpError("again", new Error("ECONNRESET"));
      ac.abort();
      return { ok: true, result: [] };
    });
    const sleeps: number[] = [];
    const poller = new TelegramPoller({
      bot,
      logger,
      status: new TelegramStatus(),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    await poller.run(ac.signal);
    expect(sleeps).toEqual([500, 1000, 2000, 500]);
  });

  it("backoffDelayMs caps at 60 s and stays within [0, ceiling)", () => {
    expect(backoffDelayMs(0, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelayMs(20, () => 0.999)).toBeLessThan(60_000);
    expect(backoffDelayMs(20, () => 0.999)).toBeGreaterThan(59_000);
    expect(backoffDelayMs(3, () => 0)).toBe(0);
  });

  it("a failing handler is logged and the offset still advances", async () => {
    const ac = new AbortController();
    let polls = 0;
    const { poller, calls } = build((call) => {
      if (call.method === "sendMessage") return { ok: false, error_code: 500, description: "boom" };
      polls += 1;
      if (polls === 1) return { ok: true, result: [messageUpdate(30, ALLOWED, "/help")] };
      ac.abort();
      return { ok: true, result: [] };
    });
    await poller.run(ac.signal);
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.update.failed")).toBe(true);
    expect(calls.filter((c) => c.method === "getUpdates")[1]?.payload["offset"]).toBe(31);
  });

  it("never writes the bot token or message text to the logs", async () => {
    const { poller } = build((call) => {
      if (call.method === "getUpdates") return { ok: false, error_code: 409, description: "Conflict" };
      return { ok: true, result: true };
    });
    await poller.handle(messageUpdate(1, STRANGER, "my-private-text"));
    expect(JSON.stringify(logger.records)).not.toContain(TOKEN);
    expect(JSON.stringify(logger.records)).not.toContain("my-private-text");
  });
});
