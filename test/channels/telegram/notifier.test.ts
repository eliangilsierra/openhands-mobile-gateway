import { Bot } from "grammy";
import type { Context } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CHUNKS,
  MAX_MESSAGE_LENGTH,
  Notifier,
  splitText,
  type OutboundNotification,
} from "../../../src/channels/telegram/notifier.js";
import type { Notification } from "../../../src/core/translate.js";
import { createRecordingLogger } from "../../store/helpers.js";
import { installFakeApi, type ApiCall, type ApiResult } from "./helpers.js";

const CHAT = 42;
const OTHER_CHAT = 43;
const CONV = "conv-1";

function note(text: string, terminal = false): Notification {
  return { text, category: terminal ? "completed" : "tool", severity: "info", terminal };
}

function out(text: string, extra: Partial<OutboundNotification> & { terminal?: boolean } = {}): OutboundNotification {
  const { terminal, ...rest } = extra;
  return { chatId: CHAT, conversationId: CONV, notification: note(text, terminal ?? false), ...rest };
}

let nextMessageId = 100;
const ok = (): ApiResult => ({ ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: CHAT, type: "private" } } });

interface Harness {
  readonly notifier: Notifier;
  readonly calls: ApiCall[];
  readonly logs: ReturnType<typeof createRecordingLogger>;
}

function setup(respond: (call: ApiCall, n: number) => ApiResult = ok, maxChunks?: number): Harness {
  const bot = new Bot<Context>("123456:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxx", {
    botInfo: undefined as never,
  });
  let n = 0;
  const calls = installFakeApi(bot, (call) => respond(call, n++));
  const logs = createRecordingLogger();
  const notifier = new Notifier({ api: bot.api, logger: logs, ...(maxChunks === undefined ? {} : { maxChunks }) });
  return { notifier, calls, logs };
}

const sends = (calls: readonly ApiCall[]): ApiCall[] => calls.filter((c) => c.method !== "getMe");

beforeEach(() => {
  vi.useFakeTimers();
  nextMessageId = 100;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("splitText", () => {
  it("prefers paragraph, then line, then hard boundaries and loses nothing", () => {
    const paragraphs = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    expect(splitText(paragraphs, 100)).toEqual([`${"a".repeat(60)}\n\n`, "b".repeat(60)]);
    const lines = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    expect(splitText(lines, 100)).toEqual([`${"a".repeat(60)}\n`, "b".repeat(60)]);
    expect(splitText("x".repeat(250), 100).join("")).toBe("x".repeat(250));
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(30); // 60 UTF-16 units
    const pieces = splitText(text, 7);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect([...piece].every((ch) => ch === "😀")).toBe(true);
    }
  });

  it("never splits a combining sequence", () => {
    const text = "é".repeat(20); // 40 units, 20 graphemes
    const pieces = splitText(text, 5);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(piece.startsWith("́")).toBe(false);
      expect(piece.length % 2).toBe(0);
    }
  });

  it("still makes progress on a grapheme longer than the limit", () => {
    const text = `e${"́".repeat(50)}`;
    const pieces = splitText(text, 10);
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((p) => p.length <= 10)).toBe(true);
  });
});

describe("chunking (T-AC-1)", () => {
  it("sends a body of exactly 4000 characters as one unmarked message", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("x".repeat(MAX_MESSAGE_LENGTH), { terminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends(calls)).toHaveLength(1);
    expect(sends(calls)[0]?.payload["text"]).toBe("x".repeat(MAX_MESSAGE_LENGTH));
  });

  it.each([MAX_MESSAGE_LENGTH + 1, 4096, 4097])("splits %i characters into marked chunks, >= 1 s apart", async (len) => {
    const { notifier, calls } = setup();
    const body = "y".repeat(len);
    notifier.enqueue(out(body, { terminal: true }));
    await vi.advanceTimersByTimeAsync(5000);
    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(texts).toHaveLength(2);
    expect(texts[0]?.startsWith("(1/2) ")).toBe(true);
    expect(texts[1]?.startsWith("(2/2) ")).toBe(true);
    expect(texts.every((t) => t.length <= 4096)).toBe(true);
    expect(texts.map((t) => t.replace(/^\(\d+\/\d+\) /, "")).join("")).toBe(body);
  });

  it("splits on paragraph boundaries when possible", async () => {
    const { notifier, calls } = setup();
    const para = (c: string): string => c.repeat(3000);
    notifier.enqueue(out(`${para("a")}\n\n${para("b")}`, { terminal: true }));
    await vi.advanceTimersByTimeAsync(5000);
    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(texts[0]).toBe(`(1/2) ${para("a")}\n\n`);
    expect(texts[1]).toBe(`(2/2) ${para("b")}`);
  });

  it(`sends a document beyond ${String(DEFAULT_MAX_CHUNKS)} chunks`, async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("z".repeat(MAX_MESSAGE_LENGTH * (DEFAULT_MAX_CHUNKS + 1)), { terminal: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendDocument"]);
  });

  it("keeps exactly MAX_CHUNKS chunks as messages", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("z".repeat(3900 * DEFAULT_MAX_CHUNKS), { terminal: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(calls).map((c) => c.method)).toEqual(Array<string>(DEFAULT_MAX_CHUNKS).fill("sendMessage"));
  });

  it.each(["log", "diff"] as const)("always sends %s content as a document, even when short", async (kind) => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("short body", { terminal: true, contentKind: kind }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendDocument"]);
    expect(sends(calls)[0]?.payload).not.toHaveProperty("parse_mode");
  });

  it("falls back to a document for an oversized log without sending chunks", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("l".repeat(20_000), { terminal: true, contentKind: "log" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendDocument"]);
  });
});

describe("coalescing (T-AC-2)", () => {
  it("merges a burst of progress into one message, then edits it", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("step 1"));
    await vi.advanceTimersByTimeAsync(0);
    for (const i of [2, 3, 4, 5]) {
      notifier.enqueue(out(`step ${String(i)}`));
    }
    await vi.advanceTimersByTimeAsync(5000);
    const s = sends(calls);
    expect(s.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(s[1]?.payload["message_id"]).toBe(100);
    expect(s[1]?.payload["text"]).toBe("step 1\nstep 2\nstep 3\nstep 4\nstep 5");
  });

  it("sends a burst queued before the first send as a single message", async () => {
    const { notifier, calls } = setup();
    for (const i of [1, 2, 3]) {
      notifier.enqueue(out(`step ${String(i)}`));
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls)).toHaveLength(1);
    expect(sends(calls)[0]?.payload["text"]).toBe("step 1\nstep 2\nstep 3");
  });

  it("gives a terminal notification its own new message and starts a fresh live status after it", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("working"));
    await vi.advanceTimersByTimeAsync(0);
    notifier.enqueue(out("done", { terminal: true }));
    await vi.advanceTimersByTimeAsync(1000);
    notifier.enqueue(out("next task"));
    await vi.advanceTimersByTimeAsync(1000);
    const s = sends(calls);
    expect(s.map((c) => c.method)).toEqual(["sendMessage", "sendMessage", "sendMessage"]);
    expect(s.map((c) => c.payload["text"])).toEqual(["working", "done", "next task"]);
  });

  it("does not merge progress of different conversations", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("a", { conversationId: "c1" }));
    notifier.enqueue(out("b", { conversationId: "c2" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls).map((c) => c.payload["text"])).toEqual(["a", "b"]);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
  });

  it("treats 'message is not modified' on edit as success (no retry)", async () => {
    const { notifier, calls } = setup((call) =>
      call.method === "editMessageText"
        ? { ok: false, error_code: 400, description: "Bad Request: message is not modified" }
        : ok(),
    );
    notifier.enqueue(out("same"));
    await vi.advanceTimersByTimeAsync(0);
    notifier.enqueue(out("same2"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
  });

  it("starts a new live message when the old one can no longer be edited", async () => {
    const { notifier, calls } = setup((call) =>
      call.method === "editMessageText" ? { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } : ok(),
    );
    notifier.enqueue(out("one"));
    await vi.advanceTimersByTimeAsync(0);
    notifier.enqueue(out("two"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendMessage", "editMessageText", "sendMessage"]);
  });
});

describe("markup safety (T-AC-3, T-B1-6)", () => {
  const HOSTILE = [
    "[x](http://e)",
    "<a href=x>click</a>",
    "<b>bold</b> _markdown_ *star* `code` ```pre```",
    "*",
    "_",
    "&lt;&amp; <script>alert(1)</script>",
    "[tg](tg://user?id=1)",
  ];

  it("sends hostile agent text verbatim on every send path, never with parse_mode", async () => {
    const { notifier, calls } = setup();
    // progress -> sendMessage, then progress -> editMessageText
    notifier.enqueue(out(HOSTILE[0] ?? ""));
    await vi.advanceTimersByTimeAsync(0);
    notifier.enqueue(out(HOSTILE[1] ?? ""));
    await vi.advanceTimersByTimeAsync(1000);
    // terminal -> sendMessage
    notifier.enqueue(out(HOSTILE.join("\n"), { terminal: true }));
    await vi.advanceTimersByTimeAsync(1000);
    // chunked -> several sendMessage
    notifier.enqueue(out(`${HOSTILE.join(" ")} `.repeat(300), { terminal: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    // documents (log, diff, oversized) incl. caption
    notifier.enqueue(out(HOSTILE.join("\n"), { terminal: true, contentKind: "log" }));
    notifier.enqueue(out(HOSTILE.join("\n"), { terminal: true, contentKind: "diff" }));
    notifier.enqueue(out(HOSTILE.join(" ").repeat(2000), { terminal: true }));
    await vi.advanceTimersByTimeAsync(10_000);

    const s = sends(calls);
    const methods = new Set(s.map((c) => c.method));
    expect(methods).toEqual(new Set(["sendMessage", "editMessageText", "sendDocument"]));
    for (const call of s) {
      expect(call.payload).not.toHaveProperty("parse_mode");
      expect(call.payload).not.toHaveProperty("entities");
      expect(call.payload).not.toHaveProperty("caption_entities");
      expect(Object.keys(call.payload).some((key) => key.includes("parse_mode"))).toBe(false);
    }
    // First message and the edit carry the hostile text unchanged (no escaping, no rewriting).
    expect(s[0]?.payload["text"]).toBe("[x](http://e)");
    expect(s[1]?.payload["text"]).toBe("[x](http://e)\n<a href=x>click</a>");
    expect(s[2]?.payload["text"]).toBe(HOSTILE.join("\n"));
  });

  it.each(HOSTILE)("delivers %s as literal text", async (input) => {
    const { notifier, calls } = setup();
    notifier.enqueue(out(input, { terminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends(calls)).toHaveLength(1);
    expect(sends(calls)[0]?.payload["text"]).toBe(input);
    expect(sends(calls)[0]?.payload).not.toHaveProperty("parse_mode");
  });
});

describe("pacing (T-AC-4)", () => {
  it("spaces sends of one chat by at least 1 s", async () => {
    const { notifier, calls } = setup();
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      notifier.enqueue(out(`t${String(i)}`, { terminal: true }));
    }
    for (let ms = 0; ms <= 3000; ms += 100) {
      await vi.advanceTimersByTimeAsync(ms === 0 ? 0 : 100);
      while (times.length < sends(calls).length) {
        times.push(ms);
      }
    }
    expect(times).toEqual([0, 1000, 2000]);
  });

  it("paces chats independently: a burst in one chat does not delay the other", async () => {
    const { notifier, calls } = setup();
    for (let i = 0; i < 5; i++) {
      notifier.enqueue(out(`burst ${String(i)}`, { terminal: true }));
    }
    notifier.enqueue({ ...out("other", { terminal: true }), chatId: OTHER_CHAT });
    await vi.advanceTimersByTimeAsync(0);
    const s = sends(calls);
    expect(s.map((c) => c.payload["chat_id"])).toEqual([CHAT, OTHER_CHAT]);
    expect(s[1]?.payload["text"]).toBe("other");
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends(calls).filter((c) => c.payload["chat_id"] === CHAT)).toHaveLength(5);
    expect(sends(calls).filter((c) => c.payload["chat_id"] === OTHER_CHAT)).toHaveLength(1);
  });
});

describe("errors (T-AC-5)", () => {
  it("honours retry_after on 429 and resends no earlier", async () => {
    let first = true;
    const { notifier, calls, logs } = setup((call) => {
      if (call.method === "sendMessage" && first) {
        first = false;
        return { ok: false, error_code: 429, description: "Too Many Requests: retry after 5", parameters: { retry_after: 5 } };
      }
      return ok();
    });
    notifier.enqueue(out("hello", { terminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4900);
    expect(sends(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sends(calls)).toHaveLength(2);
    expect(sends(calls)[1]?.payload["text"]).toBe("hello");
    expect(logs.records.some((r) => r.fields?.["event"] === "notify.rate_limited")).toBe(true);
  });

  it("drops the whole queue of a chat that blocked the bot (403) and keeps other chats", async () => {
    const { notifier, calls, logs } = setup((call) =>
      call.payload["chat_id"] === CHAT ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } : ok(),
    );
    notifier.enqueue(out("a", { terminal: true }));
    notifier.enqueue(out("b", { terminal: true }));
    notifier.enqueue({ ...out("c", { terminal: true }), chatId: OTHER_CHAT });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(calls).filter((c) => c.payload["chat_id"] === CHAT)).toHaveLength(1);
    expect(sends(calls).filter((c) => c.payload["chat_id"] === OTHER_CHAT)).toHaveLength(1);
    expect(notifier.pending(CHAT)).toBe(0);
    expect(logs.records.some((r) => r.fields?.["event"] === "notify.chat_blocked")).toBe(true);
  });

  it("retries other failures twice, then drops that notification and logs ERROR", async () => {
    const { notifier, calls, logs } = setup((call) =>
      call.payload["text"] === "bad"
        ? { ok: false, error_code: 500, description: "Internal Server Error" }
        : ok(),
    );
    notifier.enqueue(out("bad", { terminal: true }));
    notifier.enqueue(out("good", { terminal: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(calls).map((c) => c.payload["text"])).toEqual(["bad", "bad", "bad", "good"]);
    const errors = logs.records.filter((r) => r.level === "error");
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(logs.records)).not.toContain("bad\"");
  });

  it("succeeds when a retry works", async () => {
    let failures = 1;
    const { notifier, calls } = setup(() =>
      failures-- > 0 ? { ok: false, error_code: 502, description: "Bad Gateway" } : ok(),
    );
    notifier.enqueue(out("x", { terminal: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls)).toHaveLength(2);
    expect(notifier.pending(CHAT)).toBe(0);
  });

  it("never throws from enqueue and ignores empty text and use after stop", async () => {
    const { notifier, calls } = setup();
    expect(() => notifier.enqueue(out("   "))).not.toThrow();
    notifier.enqueue(out("queued", { terminal: true }));
    notifier.stop();
    notifier.enqueue(out("after", { terminal: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls)).toHaveLength(0);
  });
});
