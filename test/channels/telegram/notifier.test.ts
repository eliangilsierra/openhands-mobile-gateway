import { Bot } from "grammy";
import type { Context } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_FAILURE_NOTE,
  DEFAULT_MAX_CHUNKS,
  IDLE_CHAT_TTL_MS,
  MAX_BODY_CHARS,
  MAX_MESSAGE_LENGTH,
  MAX_QUEUED_JOBS,
  MAX_RETRY_AFTER_SECONDS,
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

function setup(
  respond: (call: ApiCall, n: number) => ApiResult | Promise<ApiResult> = ok,
  maxChunks?: number,
): Harness {
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
      if (call.method !== "sendDocument") {
        // F1: no server-side link preview; still plain text (no parse_mode / entities).
        expect(call.payload["link_preview_options"]).toEqual({ is_disabled: true });
      }
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

  it("does not delay another chat while one chat waits out a 429", async () => {
    const { notifier, calls } = setup((call) =>
      call.payload["chat_id"] === CHAT
        ? { ok: false, error_code: 429, description: "Too Many Requests: retry after 60", parameters: { retry_after: 60 } }
        : ok(),
    );
    notifier.enqueue({ ...out("other chat 1", { terminal: true }), chatId: OTHER_CHAT });
    notifier.enqueue(out("blocked chat", { terminal: true }));
    await vi.advanceTimersByTimeAsync(0); // chat 42 is rate limited for 60 s; chat 43 is tracked
    notifier.enqueue({ ...out("other chat 2", { terminal: true }), chatId: OTHER_CHAT });
    await vi.advanceTimersByTimeAsync(2000);
    const other = sends(calls).filter((c) => c.payload["chat_id"] === OTHER_CHAT);
    expect(other.map((c) => c.payload["text"])).toEqual(["other chat 1", "other chat 2"]);
    expect(sends(calls).filter((c) => c.payload["chat_id"] === CHAT)).toHaveLength(1);
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

/** Text of the Buffer behind a document upload (grammY keeps it in `InputFile.fileData`). */
function documentText(call: ApiCall | undefined): string {
  const doc: unknown = call?.payload["document"];
  if (typeof doc === "object" && doc !== null && "fileData" in doc && Buffer.isBuffer(doc.fileData)) {
    return doc.fileData.toString("utf8");
  }
  throw new Error("not a buffer-backed document");
}

describe("queue overflow keeps the in-flight job (review: CR MEDIUM)", () => {
  it("evicts the oldest queued job, not the one being sent, so its retry is not lost", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier, calls, logs } = setup(async (_call, n): Promise<ApiResult> => {
      if (n === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { ok: false, error_code: 500, description: "Internal Server Error" };
      }
      return ok();
    });
    notifier.enqueue(out("job-0", { terminal: true }));
    await vi.advanceTimersByTimeAsync(0); // job-0 is now in flight
    for (let i = 1; i <= MAX_QUEUED_JOBS; i++) {
      notifier.enqueue(out(`job-${String(i)}`, { terminal: true }));
    }
    expect(notifier.pending(CHAT)).toBe(MAX_QUEUED_JOBS);
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(600_000);

    const texts = sends(calls).map((c) => c.payload["text"]);
    expect(texts.filter((t) => t === "job-0")).toHaveLength(2); // failed once, retried and delivered
    expect(texts).not.toContain("job-1"); // the oldest QUEUED job is the one dropped
    expect(texts).toContain("job-2");
    expect(texts).toContain(`job-${String(MAX_QUEUED_JOBS)}`);
    expect(logs.records.filter((r) => r.fields?.["event"] === "notify.dropped")).toHaveLength(1);
  });
});

describe("queue overflow with chunked bodies (QA cycle 2: F-1, F-2)", () => {
  const chunkTags = (texts: readonly string[]): string[] =>
    texts.filter((t) => /^\(\d\/\d\) /.test(t)).map((t) => t.slice(0, 5));

  it("keeps the in-flight chunk (and its retry), drops the rest of the group and sends the note once", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier, calls } = setup(async (_call, n): Promise<ApiResult> => {
      if (n === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { ok: false, error_code: 500, description: "Internal Server Error" };
      }
      return ok();
    });
    notifier.enqueue(out("z".repeat(11_000), { terminal: true })); // (1/3) (2/3) (3/3)
    await vi.advanceTimersByTimeAsync(0); // (1/3) is now in flight
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      notifier.enqueue(out(`f${String(i)}`, { terminal: true }));
      expect(notifier.pending(CHAT)).toBeLessThanOrEqual(MAX_QUEUED_JOBS);
    }
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(600_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(chunkTags(texts)).toEqual(["(1/3)", "(1/3)"]); // failed once, retried, delivered; (2/3) (3/3) dropped
    expect(texts.filter((t) => t === CHUNK_FAILURE_NOTE)).toHaveLength(1);
    expect(texts.indexOf(CHUNK_FAILURE_NOTE)).toBeGreaterThan(texts.lastIndexOf(texts.find((t) => t.startsWith("(1/3)")) ?? ""));
    expect(texts).toContain(`f${String(MAX_QUEUED_JOBS - 1)}`);
    expect(notifier.pending(CHAT)).toBe(0);
  });

  it("never evicts the failure note, and sends it once, while the cap keeps dropping other jobs", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("z".repeat(11_000), { terminal: true })); // idle: three queued chunks
    for (let i = 0; i < MAX_QUEUED_JOBS + 50; i++) {
      notifier.enqueue(out(`f${String(i)}`, { terminal: true }));
    }
    expect(notifier.pending(CHAT)).toBe(MAX_QUEUED_JOBS);
    await vi.advanceTimersByTimeAsync(600_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(chunkTags(texts)).toEqual([]); // the whole group was dropped, not just its first chunk
    expect(texts.filter((t) => t === CHUNK_FAILURE_NOTE)).toHaveLength(1);
    expect(texts[0]).toBe(CHUNK_FAILURE_NOTE); // still in the place of the oldest dropped chunk
    expect(texts).toContain(`f${String(MAX_QUEUED_JOBS + 49)}`);
    expect(notifier.pending(CHAT)).toBe(0);
  });

  it("drops the whole group on a single overflow, not only as many chunks as the cap needs", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("z".repeat(11_000), { terminal: true })); // 3 queued chunks
    for (let i = 0; i < MAX_QUEUED_JOBS - 3 + 1; i++) {
      notifier.enqueue(out(`f${String(i)}`, { terminal: true })); // the last one overflows
    }
    await vi.advanceTimersByTimeAsync(600_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(chunkTags(texts)).toEqual([]);
    expect(texts.filter((t) => t === CHUNK_FAILURE_NOTE)).toHaveLength(1);
  });

  it("sends one note when a group loses a chunk to overflow and its in-flight chunk then fails for good", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier, calls } = setup(async (call, n): Promise<ApiResult> => {
      if (typeof call.payload["text"] === "string" && call.payload["text"].startsWith("(1/3)")) {
        if (n === 0) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { ok: false, error_code: 500, description: "Internal Server Error" };
      }
      return ok();
    });
    notifier.enqueue(out("z".repeat(11_000), { terminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      notifier.enqueue(out(`f${String(i)}`, { terminal: true }));
    }
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(600_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(chunkTags(texts)).toEqual(["(1/3)", "(1/3)", "(1/3)"]);
    expect(texts.filter((t) => t === CHUNK_FAILURE_NOTE)).toHaveLength(1);
  });

  it("sends none of the later chunks of a group whose note was already queued", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier, calls } = setup(async (_call, n): Promise<ApiResult> => {
      if (n === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return ok();
    });
    notifier.enqueue(out("z".repeat(11_000), { terminal: true })); // (1/3) in flight
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < MAX_QUEUED_JOBS + 100; i++) {
      notifier.enqueue(out("y".repeat(11_000), { terminal: true })); // each loses chunks to overflow
      expect(notifier.pending(CHAT)).toBeLessThanOrEqual(MAX_QUEUED_JOBS);
    }
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(3_600_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    const firstNote = texts.indexOf(CHUNK_FAILURE_NOTE);
    expect(firstNote).toBeGreaterThan(0);
    // After a group's note, none of that group's chunks may follow: every chunk sent is chunk 1 of
    // the in-flight group, or belongs to a group that was delivered whole (none here).
    expect(chunkTags(texts)).toEqual(["(1/3)"]);
    expect(notifier.pending(CHAT)).toBe(0);
  });

  it("keeps the cap when the evicted job is the last queued chunk of a group", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier } = setup(async (_call, n): Promise<ApiResult> => {
      if (n === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return ok();
    });
    notifier.enqueue(out("z".repeat(5000), { terminal: true })); // (1/2) in flight, (2/2) queued
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < MAX_QUEUED_JOBS + 5; i++) {
      notifier.enqueue(out(`f${String(i)}`, { terminal: true }));
      expect(notifier.pending(CHAT)).toBeLessThanOrEqual(MAX_QUEUED_JOBS);
    }
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(notifier.pending(CHAT)).toBe(0);
  });

  it("evicts a queued chunk of an already noted group without a second note", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier, calls } = setup(async (_call, n): Promise<ApiResult> => {
      if (n === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { ok: false, error_code: 500, description: "Internal Server Error" };
      }
      return ok();
    });
    notifier.enqueue(out("z".repeat(11_000), { terminal: true }));
    await vi.advanceTimersByTimeAsync(0); // (1/3) in flight
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      notifier.enqueue(out(`f${String(i)}`, { terminal: true })); // overflow: note queued
    }
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0); // (1/3) failed once and waits for its retry, not in flight
    notifier.enqueue(out("late", { terminal: true })); // evicts that waiting chunk of the noted group
    expect(notifier.pending(CHAT)).toBeLessThanOrEqual(MAX_QUEUED_JOBS);
    await vi.advanceTimersByTimeAsync(600_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(chunkTags(texts)).toEqual(["(1/3)"]);
    expect(texts.filter((t) => t === CHUNK_FAILURE_NOTE)).toHaveLength(1);
  });

  it("removes exactly the job that was sent, even if the queue head changed meanwhile", async () => {
    let releaseFirst: (() => void) | undefined;
    const { notifier, calls } = setup(async (_call, n): Promise<ApiResult> => {
      if (n === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return ok();
    });
    notifier.enqueue(out("sent", { terminal: true }));
    await vi.advanceTimersByTimeAsync(0); // "sent" is in flight
    // White-box: put a foreign job in front, as a future queue bug would, to pin identity removal.
    const internals = notifier as unknown as { chats: Map<string, { jobs: unknown[] }> };
    internals.chats.get(String(CHAT))?.jobs.unshift({ kind: "text", text: "foreign", attempts: 0 });
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(60_000);

    const texts = sends(calls).map((c) => c.payload["text"]);
    expect(texts).toEqual(["sent", "foreign"]); // "sent" is not sent again, "foreign" is not lost
  });
});

describe("a dropped chunk does not leave a silent gap (review: CR MEDIUM)", () => {
  it("drops the rest of the group and sends a fixed failure note instead", async () => {
    const { notifier, calls } = setup((call) =>
      typeof call.payload["text"] === "string" && call.payload["text"].startsWith("(2/3)")
        ? { ok: false, error_code: 500, description: "Internal Server Error" }
        : ok(),
    );
    notifier.enqueue(out("z".repeat(11_000), { terminal: true }));
    notifier.enqueue(out("after", { terminal: true }));
    await vi.advanceTimersByTimeAsync(60_000);

    const texts = sends(calls).map((c) => String(c.payload["text"]));
    expect(texts.map((t) => t.slice(0, 5))).toEqual(["(1/3)", "(2/3)", "(2/3)", "(2/3)", CHUNK_FAILURE_NOTE.slice(0, 5), "after"]);
    expect(texts.some((t) => t.startsWith("(3/3)"))).toBe(false);
    expect(texts[4]).toBe(CHUNK_FAILURE_NOTE);
    expect(notifier.pending(CHAT)).toBe(0);
  });
});

describe("bounded memory (review: security F3)", () => {
  it.each([
    ["log", "l".repeat(MAX_BODY_CHARS * 3), "log" as const],
    ["oversized text", "x".repeat(MAX_BODY_CHARS * 3), "text" as const],
  ])("caps a huge %s body and says it was cut", async (_name, body, kind) => {
    const { notifier, calls } = setup();
    notifier.enqueue(out(body, { terminal: true, contentKind: kind }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends(calls).map((c) => c.method)).toEqual(["sendDocument"]);
    const text = documentText(sends(calls)[0]);
    expect(text.length).toBeLessThan(MAX_BODY_CHARS + 100);
    expect(text.length).toBeGreaterThan(MAX_BODY_CHARS);
    expect(text.endsWith("[… salida truncada]")).toBe(true);
  });

  it("does not cut a body at exactly the cap", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("y".repeat(MAX_BODY_CHARS), { terminal: true, contentKind: "log" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(documentText(sends(calls)[0])).toBe("y".repeat(MAX_BODY_CHARS));
  });

  it("forgets idle chats (but not ones still pacing) when a new chat appears", async () => {
    const { notifier } = setup();
    for (let chat = 1000; chat < 1050; chat++) {
      notifier.enqueue({ ...out("hi", { terminal: true }), chatId: chat });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(notifier.trackedChats()).toBe(50);
    notifier.enqueue({ ...out("new", { terminal: true }), chatId: 2000 }); // all still pacing: nothing forgotten
    expect(notifier.trackedChats()).toBe(51);
    await vi.advanceTimersByTimeAsync(5000);
    notifier.enqueue({ ...out("newer", { terminal: true }), chatId: 3000 });
    expect(notifier.trackedChats()).toBe(1);
  });

  it("keeps a live status for a while, then forgets it", async () => {
    const { notifier } = setup();
    notifier.enqueue(out("working"));
    await vi.advanceTimersByTimeAsync(2000);
    notifier.enqueue({ ...out("other", { terminal: true }), chatId: OTHER_CHAT });
    expect(notifier.trackedChats()).toBe(2); // live status of CHAT kept, so the next progress edits it
    await vi.advanceTimersByTimeAsync(IDLE_CHAT_TTL_MS + 5000);
    notifier.enqueue({ ...out("later", { terminal: true }), chatId: 3000 });
    expect(notifier.trackedChats()).toBe(1);
  });
});

describe("retry_after is validated and clamped (review: security F4)", () => {
  /** Milliseconds after the 429 at which the message is resent (stepped: 100 ms, then 100 s). */
  async function resendDelay(retryAfter: number): Promise<number> {
    let first = true;
    const { notifier, calls } = setup((call) => {
      if (call.method === "sendMessage" && first) {
        first = false;
        return { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: retryAfter } };
      }
      return ok();
    });
    notifier.enqueue(out("hello", { terminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    let elapsed = 0;
    while (elapsed < 4_000_000) {
      const step = elapsed < 10_000 ? 100 : 100_000;
      await vi.advanceTimersByTimeAsync(step);
      elapsed += step;
      if (sends(calls).length === 2) {
        return elapsed;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  it("clamps an absurd value to the ceiling", async () => {
    const delay = await resendDelay(1e9);
    expect(delay).toBeGreaterThanOrEqual(MAX_RETRY_AFTER_SECONDS * 1000 - 100_000);
    expect(delay).toBeLessThanOrEqual(MAX_RETRY_AFTER_SECONDS * 1000 + 200_000);
  });

  it.each([Number.NaN, 0, -5, Number.POSITIVE_INFINITY])("treats %s as a 1 s wait, not an instant retry", async (value) => {
    const delay = await resendDelay(value);
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThanOrEqual(1100);
  });
});

describe("stop() (review: CR LOW)", () => {
  it("clears timers and drops queued jobs without calling the API", async () => {
    const { notifier, calls } = setup();
    notifier.enqueue(out("a", { terminal: true }));
    notifier.enqueue(out("b", { terminal: true }));
    expect(vi.getTimerCount()).toBe(1);
    expect(notifier.pending(CHAT)).toBe(2);
    notifier.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(notifier.pending(CHAT)).toBe(0);
    expect(notifier.trackedChats()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends(calls)).toHaveLength(0);
  });

  it("lets an in-flight send finish but schedules nothing afterwards", async () => {
    let release: (() => void) | undefined;
    const { notifier, calls } = setup(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok();
    });
    notifier.enqueue(out("a", { terminal: true }));
    notifier.enqueue(out("b", { terminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    notifier.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends(calls).map((c) => c.payload["text"])).toEqual(["a"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
