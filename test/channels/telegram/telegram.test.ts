import { HttpError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_UPDATES,
  backoffDelayMs,
  createBot,
  sanitizeErrorMessage,
  POLL_LIMIT,
  POLL_TIMEOUT_SECONDS,
  TelegramPoller,
} from "../../../src/channels/telegram/bot.js";
import { HELP_TEXT } from "../../../src/channels/telegram/commands/help.js";
import {
  DEFAULT_MAX_TRACKED_SENDERS,
  DEFAULT_REJECTION_WINDOW_MS,
  hashUserId,
  RejectionThrottle,
  UNAUTHORIZED_TEXT,
} from "../../../src/channels/telegram/middleware/allowlist.js";
import { TelegramStatus } from "../../../src/channels/telegram/status.js";
import { ChatStateRepository } from "../../../src/store/chat-state.js";
import { closeStore, openStore } from "../../../src/store/db.js";
import { createRecordingLogger, createTempDbPath } from "../../store/helpers.js";
import { BOT_INFO as BASE_BOT_INFO, installFakeApi, messageUpdate, type ApiCall, type ApiResult } from "./helpers.js";
import type { DatabaseSync } from "node:sqlite";

const ALLOWED = 1001;
const STRANGER = 9999;
const TOKEN = "123456:TEST-TOKEN-NOT-REAL";
const SALT = "test-salt";

/** Bot info typed against grammY `UserFromGetMe`, which requires more fields than the shared helper sets. */
const BOT_INFO: UserFromGetMe = {
  ...BASE_BOT_INFO,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

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

function build(respond?: (call: ApiCall) => ApiResult | Promise<ApiResult>) {
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
      await poller.handle(messageUpdate(i + 1, STRANGER + i, text));
    }
    const texts = sends(calls).map((c) => c.payload["text"]);
    expect(texts).toEqual(inputs.map(() => UNAUTHORIZED_TEXT));

    const rejected = logger.records.filter((r) => r.fields?.["event"] === "telegram.update.rejected");
    expect(rejected).toHaveLength(inputs.length);
    // Same message and event for every input; only the (hashed) sender reference differs.
    expect(new Set(rejected.map((r) => `${r.level}|${r.msg}|${String(r.fields?.["event"])}`))).toHaveProperty("size", 1);
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
    await poller.handle({ update_id: 6, edited_message: { ...messageUpdate(6, ALLOWED, "x").message!, edit_date: 1 } });
    expect(sends(calls)[0]?.payload["text"]).toBe(UNAUTHORIZED_TEXT);
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.update.rejected")).toBe(true);
  });

  it("still logs and does not throw when the rejection reply fails", async () => {
    const { poller } = build(() => ({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" }));
    await expect(poller.handle(messageUpdate(1, STRANGER, "hi"))).resolves.toBeUndefined();
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.update.reject_reply_failed")).toBe(true);
  });

  it("SEC-MEDIUM-1: replies at most once per sender per window, then again after it", async () => {
    let clock = 1_000_000;
    const bot = createBot({ token: TOKEN, allowedUserIds: new Set([ALLOWED]), chatState, logger, allowlistSalt: SALT, rejectionWindowMs: 60_000, now: () => clock });
    bot.botInfo = BOT_INFO;
    const calls = installFakeApi(bot, () => ({ ok: true, result: true }));
    const poller = new TelegramPoller({ bot, logger, status: new TelegramStatus(), sleep: () => Promise.resolve() });

    for (let i = 1; i <= 5; i += 1) await poller.handle(messageUpdate(i, STRANGER, "spam"));
    expect(sends(calls)).toHaveLength(1);

    clock += 60_000;
    await poller.handle(messageUpdate(6, STRANGER, "spam"));
    expect(sends(calls)).toHaveLength(2);
    // A different sender is not affected by the first one's window.
    await poller.handle(messageUpdate(7, STRANGER + 1, "hi"));
    expect(sends(calls)).toHaveLength(3);
  });

  it("SEC-MEDIUM-2: logs the first rejection per window and summarises the rest", async () => {
    let clock = 5_000;
    const bot = createBot({ token: TOKEN, allowedUserIds: new Set([ALLOWED]), chatState, logger, allowlistSalt: SALT, now: () => clock });
    bot.botInfo = BOT_INFO;
    installFakeApi(bot, () => ({ ok: true, result: true }));
    const poller = new TelegramPoller({ bot, logger, status: new TelegramStatus(), sleep: () => Promise.resolve() });

    for (let i = 1; i <= 5; i += 1) await poller.handle(messageUpdate(i, STRANGER, "spam"));
    const events = () => logger.records.map((r) => r.fields?.["event"]);
    expect(events().filter((e) => e === "telegram.update.rejected")).toHaveLength(1);
    expect(events()).not.toContain("telegram.update.rejected_summary");

    clock += 60_000;
    await poller.handle(messageUpdate(6, STRANGER, "spam"));
    const summary = logger.records.find((r) => r.fields?.["event"] === "telegram.update.rejected_summary");
    expect(summary?.msg).toContain("Suppressed 4");
    expect(summary?.fields?.["chat_ref"]).toBe(hashUserId(STRANGER, SALT));
    expect(events().filter((e) => e === "telegram.update.rejected")).toHaveLength(2);
  });

  it("SEC-MEDIUM-1: stays silent in group chats but still logs once", async () => {
    const { poller, calls } = build();
    await poller.handle(messageUpdate(1, STRANGER, "hi", "supergroup"));
    expect(calls).toHaveLength(0);
    expect(logger.records.filter((r) => r.fields?.["event"] === "telegram.update.rejected")).toHaveLength(1);
  });

  it("SEC-MEDIUM-1: tracked senders stay bounded and evicted ones get their summary", () => {
    const throttle = new RejectionThrottle(logger, 60_000, 5, () => 1_000);
    expect(throttle.admit("first")).toBe(true);
    expect(throttle.admit("first")).toBe(false);
    for (let i = 0; i < 500; i += 1) throttle.admit(`sender-${i}`);
    expect(throttle.size).toBe(5);
    const summaries = logger.records.filter((r) => r.fields?.["event"] === "telegram.update.rejected_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.msg).toContain("Suppressed 1");
  });

  it("SEC-MEDIUM-1: defaults are a 60 s window and 1000 tracked senders", async () => {
    expect(DEFAULT_REJECTION_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_MAX_TRACKED_SENDERS).toBe(1_000);

    // Through the real wiring, with no overrides: the 1001st distinct sender evicts the first one,
    // which then gets a fresh reply and a summary even though its window has not elapsed.
    let clock = 1_000_000;
    const bot = createBot({ token: TOKEN, allowedUserIds: new Set([ALLOWED]), chatState, logger, allowlistSalt: SALT, now: () => clock });
    bot.botInfo = BOT_INFO;
    const calls = installFakeApi(bot, () => ({ ok: true, result: true }));
    const poller = new TelegramPoller({ bot, logger, status: new TelegramStatus(), sleep: () => Promise.resolve() });
    const first = STRANGER;

    await poller.handle(messageUpdate(1, first, "a"));
    await poller.handle(messageUpdate(2, first, "b"));
    expect(sends(calls)).toHaveLength(1);
    clock += DEFAULT_REJECTION_WINDOW_MS - 1;
    await poller.handle(messageUpdate(3, first, "c"));
    expect(sends(calls)).toHaveLength(1);

    // 999 other senders fill the map to exactly 1000: nobody is evicted yet.
    for (let i = 1; i < DEFAULT_MAX_TRACKED_SENDERS; i += 1) await poller.handle(messageUpdate(100 + i, first + i, "x"));
    expect(sends(calls)).toHaveLength(DEFAULT_MAX_TRACKED_SENDERS);
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.update.rejected_summary")).toBe(false);

    // The 1001st sender evicts the oldest (the first), which is summarised and answered again.
    await poller.handle(messageUpdate(5000, first + DEFAULT_MAX_TRACKED_SENDERS, "x"));
    const summary = logger.records.find((r) => r.fields?.["event"] === "telegram.update.rejected_summary");
    expect(summary?.msg).toContain("Suppressed 2");
    await poller.handle(messageUpdate(5001, first, "again"));
    expect(sends(calls)).toHaveLength(DEFAULT_MAX_TRACKED_SENDERS + 2);

    // A fresh sender admitted at exactly the window boundary is answered again (window is 60 s, not more).
    const boundaryBot = createBot({ token: TOKEN, allowedUserIds: new Set([ALLOWED]), chatState, logger, allowlistSalt: SALT, now: () => clock });
    boundaryBot.botInfo = BOT_INFO;
    const boundaryCalls = installFakeApi(boundaryBot, () => ({ ok: true, result: true }));
    const boundary = new TelegramPoller({ bot: boundaryBot, logger, status: new TelegramStatus(), sleep: () => Promise.resolve() });
    await boundary.handle(messageUpdate(1, first, "a"));
    clock += DEFAULT_REJECTION_WINDOW_MS - 1;
    await boundary.handle(messageUpdate(2, first, "b"));
    expect(sends(boundaryCalls)).toHaveLength(1);
    clock += 1;
    await boundary.handle(messageUpdate(3, first, "c"));
    expect(sends(boundaryCalls)).toHaveLength(2);
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

  it("T-AC-4: 409 logs ERROR, reports disconnected with reason conflict, retries and never calls deleteWebhook", async () => {
    const ac = new AbortController();
    let polls = 0;
    const statusDuringConflict: string[] = [];
    const reasonDuringConflict: (string | null)[] = [];
    const holder: { status?: TelegramStatus } = {};
    const { poller, calls, status, sleeps } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls === 3 && holder.status) {
        statusDuringConflict.push(holder.status.get());
        reasonDuringConflict.push(holder.status.reason());
      }
      if (polls <= 2) return { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" };
      ac.abort();
      return { ok: true, result: [] };
    });
    holder.status = status;
    await poller.run(ac.signal);

    expect(statusDuringConflict).toEqual(["disconnected"]);
    expect(reasonDuringConflict).toEqual(["conflict"]);
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.poll.recovered")).toBe(true);
    const errors = logger.records.filter((r) => r.level === "error" && r.fields?.["event"] === "telegram.poll.conflict");
    expect(errors).toHaveLength(2);
    expect(calls.some((c) => c.method === "deleteWebhook")).toBe(false);
    expect(sleeps).toEqual([500, 1000]);
    expect(status.get()).toBe("connected");
    expect(status.reason()).toBeNull();
  });

  it("409 keeps the status disconnected (reason conflict) while the conflict lasts", async () => {
    const ac = new AbortController();
    let polls = 0;
    const observed: string[] = [];
    const { poller, status } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls === 3) {
        observed.push(`${status.get()}/${String(status.reason())}`);
        ac.abort();
        return { ok: true, result: [] };
      }
      return { ok: false, error_code: 409, description: "Conflict" };
    });
    await poller.run(ac.signal);
    expect(observed).toEqual(["disconnected/conflict"]);
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

  it("CR-1: aborting an in-flight long poll ends run() immediately and passes the signal", async () => {
    const ac = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const { poller } = build(async (call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      seenSignal = call.signal;
      await new Promise<void>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        queueMicrotask(() => ac.abort());
      });
      return { ok: true, result: [] };
    });
    await poller.run(ac.signal);
    expect(seenSignal).toBeDefined();
    expect(ac.signal.aborted).toBe(true);
  });

  it("CR-1: abort between updates of a batch stops processing the rest", async () => {
    const ac = new AbortController();
    const { poller, calls } = build((call) => {
      if (call.method === "sendMessage") {
        ac.abort();
        return { ok: true, result: true };
      }
      return { ok: true, result: [messageUpdate(40, ALLOWED, "/help"), messageUpdate(41, ALLOWED, "/help")] };
    });
    await poller.run(ac.signal);
    expect(sends(calls)).toHaveLength(1);
  });

  it("CR-7: a repeated update_id across polls is processed once", async () => {
    const ac = new AbortController();
    let polls = 0;
    const { poller, calls } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls === 1) return { ok: true, result: [messageUpdate(50, ALLOWED, "/help")] };
      if (polls === 2) return { ok: true, result: [messageUpdate(50, ALLOWED, "/help"), messageUpdate(51, ALLOWED, "/help")] };
      ac.abort();
      return { ok: true, result: [] };
    });
    await poller.run(ac.signal);
    expect(sends(calls)).toHaveLength(2);
  });

  it("CR-2: 401 logs a clear ERROR without the token, reports disconnected (reason unauthorized) and still backs off", async () => {
    const ac = new AbortController();
    let polls = 0;
    const { poller, status, sleeps } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls <= 2) return { ok: false, error_code: 401, description: "Unauthorized" };
      ac.abort();
      return { ok: true, result: [] };
    });
    const seen: string[] = [];
    const observe = status.setDisconnected.bind(status);
    status.setDisconnected = (reason) => {
      seen.push(reason);
      observe(reason);
      expect(status.get()).toBe("disconnected");
    };
    await poller.run(ac.signal);

    const errors = logger.records.filter((r) => r.level === "error" && r.fields?.["event"] === "telegram.poll.unauthorized");
    expect(errors).toHaveLength(2);
    expect(errors[0]?.msg).toContain("TELEGRAM_BOT_TOKEN");
    expect(errors[0]?.fields?.["status"]).toBe(401);
    expect(logger.records.some((r) => r.fields?.["event"] === "telegram.poll.error")).toBe(false);
    expect(JSON.stringify(logger.records)).not.toContain(TOKEN);
    expect(seen.slice(0, 2)).toEqual(["unauthorized", "unauthorized"]);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("CR-2: 404 (revoked token) is treated like 401", async () => {
    const ac = new AbortController();
    let polls = 0;
    const observed: string[] = [];
    const { poller, status } = build((call) => {
      if (call.method !== "getUpdates") return { ok: true, result: true };
      polls += 1;
      if (polls === 2) {
        observed.push(`${status.get()}/${String(status.reason())}`);
        ac.abort();
        return { ok: true, result: [] };
      }
      return { ok: false, error_code: 404, description: "Not Found" };
    });
    await poller.run(ac.signal);
    expect(observed).toEqual(["disconnected/unauthorized"]);
  });

  it("SEC-LOW-2: handler errors are logged with a bounded, token-free message", async () => {
    const { bot, poller } = build();
    bot.command("boom", () => {
      throw new Error(`${TOKEN} ${"x".repeat(1000)}\nmy-private-text`);
    });
    await poller.handle(messageUpdate(60, ALLOWED, "/boom"));
    const failed = logger.records.find((r) => r.fields?.["event"] === "telegram.update.failed");
    const msg = String(failed?.fields?.["err_msg"]);
    expect(msg.length).toBeLessThanOrEqual(165);
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain("\n");
  });

  it("sanitizeErrorMessage handles non-Error values", () => {
    expect(sanitizeErrorMessage("plain\u0007text")).toBe("plain text");
    expect(sanitizeErrorMessage(new Error("a".repeat(500))).length).toBe(163);
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
