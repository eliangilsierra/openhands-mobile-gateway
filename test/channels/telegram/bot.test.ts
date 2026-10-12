import { describe, expect, it } from "vitest";
import { createBot, type BotHandlerDeps } from "../../../src/channels/telegram/bot.js";
import { createLogger } from "../../../src/logger.js";
import { BOT_INFO, installFakeApi, messageUpdate, type ApiCall } from "./helpers.js";

const ALLOWED = 4242;
const STRANGER = 7777;

/** Every call on any dependency is recorded; none of them returns a usable value. */
function recordingDeps(touched: string[]): BotHandlerDeps {
  const dep = (name: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, member) => {
          touched.push(`${name}.${String(member)}`);
          return () => Promise.reject(new Error("unexpected upstream call"));
        },
      },
    );
  const control = {
    chatState: dep("chatState"),
    bindings: dep("bindings"),
    client: dep("client"),
  };
  return {
    registry: dep("registry"),
    select: { registry: dep("registry"), chatState: dep("chatState"), bindings: dep("bindings") },
    submit: { ...control, registry: dep("registry") },
    control,
    confirmations: dep("confirmations"),
  } as unknown as BotHandlerDeps;
}

function build(withHandlers: boolean) {
  const lines: string[] = [];
  const touched: string[] = [];
  const bot = createBot({
    token: "123456:synthetic-token-value",
    allowedUserIds: new Set([ALLOWED]),
    chatState: { find: () => null, setActiveProject: () => undefined } as never,
    logger: createLogger({ level: "debug", secrets: [], write: (line) => lines.push(line) }),
    ...(withHandlers ? { handlers: recordingDeps(touched) } : {}),
  });
  const calls: ApiCall[] = installFakeApi(bot, (call) => {
    if (call.method === "getMe") {
      return { ok: true, result: BOT_INFO };
    }
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } };
  });
  return { bot, calls, lines, touched };
}

function callbackUpdate(id: number, userId: number, data: string) {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      chat_instance: "ci",
      from: { id: userId, is_bot: false, first_name: "Tester" },
      data,
      message: {
        message_id: 9,
        date: 1,
        chat: { id: userId, type: "private" as const, first_name: "Tester" },
      },
    },
  };
}

describe("createBot handler wiring", () => {
  it.each(["/projects", "/use alpha", "/status", "/pause", "/resume", "/stop", "build a thing"])(
    "rejects %s from a stranger without touching any dependency",
    async (text) => {
      const { bot, calls, touched } = build(true);
      await bot.init();

      await bot.handleUpdate(messageUpdate(1, STRANGER, text));

      expect(touched).toEqual([]);
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
      expect(String(calls.find((call) => call.method === "sendMessage")?.payload["text"])).toBe("⛔ Unauthorized");
    },
  );

  it.each(["c:abc:a", "c:abc:d", "garbage", ""])(
    "answers the callback %j of a stranger once and calls nothing upstream",
    async (data) => {
      const { bot, calls, touched, lines } = build(true);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(1, STRANGER, data));

      expect(touched).toEqual([]);
      const answers = calls.filter((call) => call.method === "answerCallbackQuery");
      expect(answers).toHaveLength(1);
      expect(answers[0]?.payload["text"]).toBe("⛔ Unauthorized");
      expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
      expect(lines.join("\n")).not.toContain(String(STRANGER));
    },
  );

  it("answers a callback nobody recognises so the button stops spinning", async () => {
    const { bot, calls, touched } = build(true);
    await bot.init();

    await bot.handleUpdate(callbackUpdate(1, ALLOWED, "something-else"));

    expect(touched).toEqual([]);
    expect(calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(1);
  });

  it("registers no feature handler without handlers", async () => {
    const { bot, calls } = build(false);
    await bot.init();

    await bot.handleUpdate(messageUpdate(1, ALLOWED, "/status"));

    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("never sets parse_mode on any reply", async () => {
    const { bot, calls } = build(true);
    await bot.init();

    await bot.handleUpdate(messageUpdate(1, ALLOWED, "/start"));
    await bot.handleUpdate(messageUpdate(2, ALLOWED, "/help"));
    await bot.handleUpdate(messageUpdate(3, STRANGER, "/start"));
    await bot.handleUpdate(callbackUpdate(4, STRANGER, "c:abc:a"));

    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) {
      expect(call.payload).not.toHaveProperty("parse_mode");
    }
  });

  it("bot.catch logs only the event name and the error type", async () => {
    const lines: string[] = [];
    const bot = createBot({
      token: "123456:synthetic-token-value",
      allowedUserIds: new Set([ALLOWED]),
      chatState: {
        find: () => {
          throw new TypeError("secret user text 123456:synthetic-token-value");
        },
        setActiveProject: () => undefined,
      } as never,
      logger: createLogger({ level: "debug", secrets: [], write: (line) => lines.push(line) }),
    });
    installFakeApi(bot, (call) =>
      call.method === "getMe"
        ? { ok: true, result: BOT_INFO }
        : { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } },
    );
    await bot.init();

    // handleUpdate rethrows (the poller logs and skips); bot.catch serves grammY's own runners.
    const failure = await bot.handleUpdate(messageUpdate(1, ALLOWED, "/start")).catch((error: unknown) => error);
    await bot.errorHandler(failure as never);

    const line = lines.find((entry) => entry.includes("telegram.handler_failed"));
    expect(line).toBeDefined();
    expect(line).toContain("TypeError");
    expect(line).not.toContain("secret user text");
    expect(line).not.toContain("synthetic-token-value");
  });
});
