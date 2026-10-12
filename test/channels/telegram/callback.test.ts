import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Update } from "grammy/types";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANSWERED_ALLOW_TEXT,
  ANSWERED_DENY_TEXT,
  EXPIRED_TEXT,
  REJECTED_TEXT,
  buildConfirmationKeyboard,
  registerConfirmationCallbacks,
  telegramPromptSender,
} from "../../../src/channels/telegram/handlers/callback.js";
import { allowlistMiddleware } from "../../../src/channels/telegram/middleware/allowlist.js";
import { CALLBACK_DATA_MAX_BYTES, ConfirmationService, type AnswerRequest } from "../../../src/core/confirmations.js";
import { createOpenHandsRestClient } from "../../../src/openhands/rest.js";
import { closeStore, openStore } from "../../../src/store/db.js";
import { PendingConfirmationRepository } from "../../../src/store/pending-confirmation.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../../mocks/openhands-server.js";
import { createRecordingLogger, createTempDbPath } from "../../store/helpers.js";
import { BOT_INFO, installFakeApi, type ApiCall } from "./helpers.js";

const USER = 1001;
const OTHER = 2002;
const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const ACTION = "99999999-aaaa-bbbb-cccc-dddddddddddd";
const PROMPT_MESSAGE = 500;

let server: MockOpenHandsServer;
let db: DatabaseSync;
let cleanup: () => void;
let store: PendingConfirmationRepository;
let clock: Date;

beforeAll(async () => {
  server = await startMockOpenHandsServer("k");
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.clearRules();
  server.requests.length = 0;
  const temp = createTempDbPath();
  cleanup = temp.cleanup;
  const logger = createRecordingLogger();
  clock = new Date("2026-01-01T00:00:00.000Z");
  db = openStore({ databasePath: temp.path, logger });
  store = new PendingConfirmationRepository(db, logger, () => clock);
});
afterEach(() => {
  closeStore(db);
  cleanup();
});

function build(options: { allowed?: number[]; answer?: (r: AnswerRequest) => void } = {}) {
  const client = createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } });
  const logger = createRecordingLogger();
  const service = new ConfirmationService({ store, client, logger, now: () => clock });
  const bot = new Bot<Context>("123456:TEST-TOKEN-NOT-REAL");
  bot.botInfo = {
    ...BOT_INFO,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls = installFakeApi(bot, (call) => {
    if (call.method === "sendMessage") {
      return { ok: true, result: { message_id: PROMPT_MESSAGE, date: 0, chat: { id: USER, type: "private" } } };
    }
    return { ok: true, result: true };
  });
  bot.use(allowlistMiddleware({ allowedUserIds: new Set(options.allowed ?? [USER, OTHER]), logger }));
  registerConfirmationCallbacks(bot, {
    confirmations: options.answer
      ? { answer: (r) => (options.answer?.(r), service.answer(r)) }
      : service,
    logger,
  });
  return { bot, calls, service, logger };
}

function tap(
  data: string,
  options: { user?: number; chat?: number; messageId?: number; chatType?: "private" | "supergroup" } = {},
): Update {
  const user = options.user ?? USER;
  const chat = options.chat ?? user;
  const messageId = options.messageId ?? PROMPT_MESSAGE;
  const chatType = options.chatType ?? "private";
  return {
    update_id: 1,
    callback_query: {
      id: "cbq-1",
      chat_instance: "ci",
      from: { id: user, is_bot: false, first_name: "T" },
      data,
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: chatType === "private" ? { id: chat, type: "private", first_name: "T" } : { id: chat, type: "supergroup", title: "G" },
        text: "prompt",
      },
    },
  };
}

const methods = (calls: ApiCall[], name: string) => calls.filter((c) => c.method === name);
const toasts = (calls: ApiCall[]) => methods(calls, "answerCallbackQuery").map((c) => c.payload["text"]);
const respondCalls = () => server.requests.filter((r) => r.path.endsWith("/respond_to_confirmation"));

async function prompt(service: ConfirmationService, chat = String(USER)): Promise<number> {
  const result = await service.request(
    { conversationId: CONVERSATION, actionEventId: ACTION, channel: "telegram", externalChatId: chat },
    () => Promise.resolve(String(PROMPT_MESSAGE)),
  );
  if (result.status !== "sent") throw new Error("not sent");
  return result.id;
}

describe("keyboard", () => {
  it("has Permitir/Denegar buttons whose callback_data is <= 64 bytes and holds no UUID", () => {
    const rows = buildConfirmationKeyboard(123).inline_keyboard;
    const buttons = rows.flat();
    expect(buttons.map((b) => b.text)).toEqual(["✅ Permitir", "❌ Denegar"]);
    for (const button of buttons) {
      const data = "callback_data" in button ? button.callback_data : "";
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      expect(data).toMatch(/^c:123:[ad]$/);
    }
  });

  it("sends the prompt with the keyboard and returns the message id", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    const send = telegramPromptSender(bot.api, String(USER), "¿Permitir?");
    expect(await send(id)).toBe(String(PROMPT_MESSAGE));
    const sent = methods(calls, "sendMessage")[0];
    expect(sent?.payload["text"]).toBe("¿Permitir?");
    expect(JSON.stringify(sent?.payload["reply_markup"])).toContain(`c:${String(id)}:a`);
  });
});

describe("callback handling", () => {
  it("Permitir: calls respond_to_confirmation, answers the tap and removes the keyboard (T-AC-1)", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:a`));
    expect(respondCalls()).toHaveLength(1);
    expect(respondCalls()[0]?.body).toEqual({ accept: true, reason: "telegram user decision" });
    expect(toasts(calls)).toEqual([ANSWERED_ALLOW_TEXT]);
    const edit = methods(calls, "editMessageReplyMarkup");
    expect(edit).toHaveLength(1);
    expect(edit[0]?.payload["message_id"]).toBe(PROMPT_MESSAGE);
    expect(JSON.stringify(edit[0]?.payload["reply_markup"])).toBe('{"inline_keyboard":[]}');
  });

  it("Denegar sends accept: false", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:d`));
    expect(respondCalls()[0]?.body).toEqual({ accept: false, reason: "telegram user decision" });
    expect(toasts(calls)).toEqual([ANSWERED_DENY_TEXT]);
  });

  it("a replayed tap is answered with the expired toast and not forwarded (T-AC-2)", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:a`));
    await bot.handleUpdate(tap(`c:${String(id)}:a`));
    expect(respondCalls()).toHaveLength(1);
    expect(toasts(calls)).toEqual([ANSWERED_ALLOW_TEXT, EXPIRED_TEXT]);
  });

  it("a tap in another chat is rejected, answered, and leaves the keyboard alone (T-AC-3)", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:a`, { user: OTHER }));
    expect(respondCalls()).toHaveLength(0);
    expect(toasts(calls)).toEqual([REJECTED_TEXT]);
    expect(methods(calls, "editMessageReplyMarkup")).toHaveLength(0);
    expect(store.findById(id)?.resolvedAt).toBeNull();
  });

  it("a keyboard forwarded to a group is rejected even from the right user", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:a`, { chat: -100_123, chatType: "supergroup" }));
    expect(respondCalls()).toHaveLength(0);
    expect(toasts(calls)).toEqual([REJECTED_TEXT]);
  });

  it("a tap on another message than the prompt is rejected", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:a`, { messageId: 9 }));
    expect(respondCalls()).toHaveLength(0);
    expect(toasts(calls)).toEqual([REJECTED_TEXT]);
  });

  it("an expired prompt shows the toast and calls nothing (T-AC-5)", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    clock = new Date(clock.getTime() + 3600 * 1000);
    await bot.handleUpdate(tap(`c:${String(id)}:a`));
    expect(respondCalls()).toHaveLength(0);
    expect(toasts(calls)).toEqual([EXPIRED_TEXT]);
    expect(methods(calls, "editMessageReplyMarkup")).toHaveLength(1);
  });

  it.each(["c:", "c:abc:a", "c:1:z", `c:${CONVERSATION}:a`, "c:1:a:extra"])(
    "forged data %j is answered and ignored",
    async (data) => {
      const { bot, calls } = build();
      await bot.handleUpdate(tap(data));
      expect(respondCalls()).toHaveLength(0);
      expect(toasts(calls)).toHaveLength(1);
    },
  );

  it("an unknown id is answered with the expired toast", async () => {
    const { bot, calls } = build();
    await bot.handleUpdate(tap("c:4242:a"));
    expect(toasts(calls)).toEqual([EXPIRED_TEXT]);
  });

  it("answers the tap even when the upstream call fails, and lets the user retry", async () => {
    const { bot, calls, service } = build();
    const id = await prompt(service);
    server.addRule({ method: "POST", path: /respond_to_confirmation$/, status: 503, times: 1 });
    await bot.handleUpdate(tap(`c:${String(id)}:a`));
    expect(toasts(calls)).toHaveLength(1);
    expect(methods(calls, "editMessageReplyMarkup")).toHaveLength(0);
    await bot.handleUpdate(tap(`c:${String(id)}:a`));
    expect(toasts(calls)).toEqual([expect.any(String), ANSWERED_ALLOW_TEXT]);
  });

  it("answers the tap even when the service throws", async () => {
    const { bot, calls, logger } = build({
      answer: () => {
        throw new Error("secret=hunter2hunter2");
      },
    });
    await bot.handleUpdate(tap("c:1:a"));
    expect(toasts(calls)).toHaveLength(1);
    expect(JSON.stringify(logger.records)).not.toContain("hunter2");
  });

  it("a failing keyboard removal does not break the handler", async () => {
    const { bot, service } = build();
    const id = await prompt(service);
    const calls: string[] = [];
    bot.api.config.use((prev, method, payload, signal) => {
      calls.push(method);
      if (method === "editMessageReplyMarkup") {
        return Promise.resolve({ ok: false, error_code: 400, description: "message is not modified" } as never);
      }
      return prev(method, payload, signal);
    });
    await expect(bot.handleUpdate(tap(`c:${String(id)}:a`))).resolves.toBeUndefined();
    expect(calls).toContain("answerCallbackQuery");
  });

  it("ignores callback data that is not ours", async () => {
    const { bot, calls } = build();
    await bot.handleUpdate(tap("other:1"));
    expect(calls).toHaveLength(0);
  });

  it("does not reach the handler for a user outside the allowlist", async () => {
    const { bot, service } = build({ allowed: [USER] });
    const id = await prompt(service);
    await bot.handleUpdate(tap(`c:${String(id)}:a`, { user: OTHER }));
    expect(respondCalls()).toHaveLength(0);
  });
});
