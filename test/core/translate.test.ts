import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_DETAIL_LENGTH,
  sanitizeDetail,
  translateEvent,
  translateEvents,
  translateWithClassification,
  type OpenHandsEvent,
} from "../../src/core/translate.js";

let n = 0;
function ev(kind: string, fields: Record<string, unknown> = {}): OpenHandsEvent {
  n += 1;
  return {
    id: `evt-${n}`,
    timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}Z`,
    source: "agent",
    parent_id: null,
    kind,
    ...fields,
  };
}
const texts = (events: readonly OpenHandsEvent[]): string[] => translateEvents(events).map((x) => x.text);

describe("taxonomy", () => {
  it("thinking -> Analizando", () => {
    expect(texts([ev("ActionEvent", { tool_name: "think", summary: "pondering" })])).toEqual(["🧠 Analizando…"]);
  });

  it("file edit -> Modificando: <file> from action.path", () => {
    const e = ev("ActionEvent", { tool_name: "str_replace_editor", summary: "Edit file", action: { path: "src/file.ts" } });
    expect(translateEvent(e)).toEqual([
      { text: "🔧 Modificando: src/file.ts", category: "editing", severity: "info", terminal: false },
    ]);
  });

  it("file edit falls back to summary when no path field", () => {
    const e = ev("ActionEvent", { tool_name: "file_editor", summary: "Editing src/a.ts" });
    expect(texts([e])).toEqual(["🔧 Modificando: Editing src/a.ts"]);
  });

  it("other tool -> generic tool line using summary then tool_name", () => {
    expect(texts([ev("ActionEvent", { tool_name: "browser", summary: "Open docs" })])).toEqual(["🔧 Ejecutando: Open docs"]);
    expect(texts([ev("ActionEvent", { tool_name: "browser" })])).toEqual(["🔧 Ejecutando: browser"]);
    expect(texts([ev("ActionEvent", {})])).toEqual(["🔧 Ejecutando una herramienta"]);
  });

  it("test run -> Ejecutando tests", () => {
    const e = ev("ActionEvent", { tool_name: "terminal", summary: "Run unit tests", action: { command: "npm test" } });
    expect(texts([e])).toEqual(["🧪 Ejecutando tests…"]);
  });

  it("finish action -> completed with short summary, terminal", () => {
    const e = ev("ActionEvent", { tool_name: "finish", action: { message: "All done" } });
    expect(translateEvent(e)).toEqual([
      { text: "✅ Tarea completada: All done", category: "completed", severity: "info", terminal: true },
    ]);
    expect(texts([ev("ActionEvent", { tool_name: "finish" })])).toEqual(["✅ Tarea completada"]);
  });

  it("state updates: finished, error, stuck, waiting", () => {
    const s = (value: string): OpenHandsEvent => ev("ConversationStateUpdateEvent", { key: "execution_status", value });
    expect(texts([s("finished")])).toEqual(["✅ Tarea completada"]);
    expect(translateEvent(s("error"))[0]).toMatchObject({ text: "💥 La tarea falló", severity: "error", terminal: true });
    expect(translateEvent(s("stuck"))[0]).toMatchObject({ text: "🧱 El agente está atascado", terminal: true });
    expect(translateEvent(s("waiting_for_confirmation"))[0]).toMatchObject({ category: "waiting", terminal: false });
  });

  it("idle/running states and other keys are suppressed", () => {
    expect(translateEvent(ev("ConversationStateUpdateEvent", { key: "execution_status", value: "idle" }))).toEqual([]);
    expect(translateEvent(ev("ConversationStateUpdateEvent", { key: "execution_status", value: "running" }))).toEqual([]);
    expect(translateEvent(ev("ConversationStateUpdateEvent", { key: "stats", value: "finished" }))).toEqual([]);
  });

  it("AgentErrorEvent -> non-terminal tool warning (failure comes from the status), no error body", () => {
    const e = ev("AgentErrorEvent", { error: "Traceback with token=abc123456789" });
    const [out] = translateEvent(e);
    expect(out).toMatchObject({ text: "⚠️ Una herramienta devolvió un error", category: "tool", severity: "warning", terminal: false });
    expect(JSON.stringify(out)).not.toContain("abc123456789");
  });

  it("a recoverable tool error followed by finish is not reported as a failed task", () => {
    const out = translateEvents([
      ev("AgentErrorEvent", { error: "boom" }),
      ev("ActionEvent", { tool_name: "finish", action: { message: "fixed" } }),
    ]);
    expect(out.some((x) => x.category === "failed")).toBe(false);
    expect(out.filter((x) => x.terminal).map((x) => x.category)).toEqual(["completed"]);
  });

  it("an edit whose summary names a test runner is still an edit (CR-3)", () => {
    for (const summary of ["Update jest config", "Fix mocha setup", "tox.ini edit"]) {
      const e = ev("ActionEvent", { tool_name: "str_replace_editor", summary, action: { path: "src/conf.ts" } });
      expect(translateEvent(e)).toEqual([
        { text: "🔧 Modificando: src/conf.ts", category: "editing", severity: "info", terminal: false },
      ]);
    }
    expect(texts([ev("ActionEvent", { tool_name: "file_editor", summary: "Update jest config" })])).toEqual([
      "🔧 Modificando: Update jest config",
    ]);
    // shell tools are still recognised
    expect(texts([ev("ActionEvent", { tool_name: "terminal", action: { command: "pytest -q" } })])).toEqual(["🧪 Ejecutando tests…"]);
  });

  it("T-AC-3: UserRejectObservation from user -> Acción denegada; other sources suppressed", () => {
    expect(texts([ev("UserRejectObservation", { rejection_source: "user" })])).toEqual(["❌ Acción denegada"]);
    expect(translateEvent(ev("UserRejectObservation", { rejection_source: "hook" }))).toEqual([]);
  });
});

describe("T-AC-1 sequence", () => {
  it("yields friendly messages, never raw JSON", () => {
    const out = texts([
      ev("ActionEvent", { tool_name: "think" }),
      ev("ObservationEvent", { tool_name: "think" }),
      ev("ActionEvent", { tool_name: "str_replace_editor", action: { path: "src/file.ts" } }),
      ev("ObservationEvent", {}),
      ev("ActionEvent", { tool_name: "finish" }),
    ]);
    expect(out).toEqual(["🧠 Analizando…", "🔧 Modificando: src/file.ts", "✅ Tarea completada"]);
    for (const t of out) expect(t).not.toMatch(/[{}"]|evt-/);
  });
});

describe("T-AC-2 suppression", () => {
  it("observations and messages produce nothing", () => {
    for (const kind of ["ObservationEvent", "MessageEvent", "SystemPromptEvent", "PauseEvent"]) {
      expect(translateWithClassification(ev(kind))).toMatchObject({ classification: "event.suppressed", reason: "low_signal" });
    }
  });

  it("a burst of thinking ticks collapses to one message", () => {
    const burst = Array.from({ length: 20 }, () => ev("ActionEvent", { tool_name: "think" }));
    expect(texts(burst)).toEqual(["🧠 Analizando…"]);
  });

  it("collapses duplicate completion, keeps distinct edits, honours previous", () => {
    const edit = (p: string): OpenHandsEvent => ev("ActionEvent", { tool_name: "file_editor", action: { path: p } });
    expect(texts([edit("a.ts"), edit("a.ts"), edit("b.ts")])).toEqual(["🔧 Modificando: a.ts", "🔧 Modificando: b.ts"]);
    expect(texts([
      ev("ActionEvent", { tool_name: "finish" }),
      ev("ConversationStateUpdateEvent", { key: "execution_status", value: "finished" }),
    ])).toEqual(["✅ Tarea completada"]);
    const prev = translateEvent(ev("ActionEvent", { tool_name: "think" }))[0];
    expect(translateEvents([ev("ActionEvent", { tool_name: "think" })], prev)).toEqual([]);
  });
});

describe("T-AC-4 unknown / malformed", () => {
  it("unknown kind does not throw and is classified suppressed", () => {
    expect(translateWithClassification(ev("FutureEvent", { x: 1 }))).toEqual({
      notifications: [],
      classification: "event.suppressed",
      reason: "unknown_kind",
    });
  });

  it("prototype-like kinds are unknown, not handlers", () => {
    for (const kind of ["constructor", "__proto__", "toString", ""]) {
      expect(translateWithClassification(ev(kind)).reason).toBe("unknown_kind");
    }
  });

  it("malformed field types do not throw", () => {
    const e = ev("ActionEvent", { tool_name: 42, summary: { a: 1 }, action: "x" });
    expect(() => translateEvent(e)).not.toThrow();
    const bad = { id: "x", timestamp: "t", source: "s", kind: 5 } as unknown as OpenHandsEvent;
    expect(translateEvent(bad)).toEqual([]);
  });

  it("classification of a translated event", () => {
    expect(translateWithClassification(ev("ActionEvent", { tool_name: "think" })).classification).toBe("event.translated");
  });
});

describe("safety", () => {
  it("redacts secrets in details", () => {
    const samples = [
      "ghp_abcdefghijklmnop1234",
      "sk-abcdefghijklmnop1234",
      "Bearer abcdefghijklmnop1234",
      "api_key=supersecretvalue",
      "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdef",
    ];
    for (const s of samples) {
      const out = sanitizeDetail(`edit with ${s} now`);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain(s.split(/[ =]/).at(-1) ?? "###");
    }
  });

  it("strips control and bidi characters and newlines, collapses whitespace", () => {
    expect(sanitizeDetail("a\nb\r\tc d\u202ee   f\u200bg")).toBe("a b c d e f g");
  });

  it("truncates by code points", () => {
    const out = sanitizeDetail("😀".repeat(500));
    expect(Array.from(out)).toHaveLength(MAX_DETAIL_LENGTH);
    expect(out.endsWith("…")).toBe(true);
    expect(sanitizeDetail("short")).toBe("short");
  });

  it("applies sanitising to summary and path in notifications", () => {
    const e = ev("ActionEvent", { tool_name: "file_editor", action: { path: `src/${"x".repeat(400)}\n.ts` } });
    const [out] = translateEvent(e);
    expect(out?.text).not.toContain("\n");
    expect(Array.from(out?.text ?? "").length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH + "🔧 Modificando: ".length);
  });

  it("is pure: does not mutate input and is deterministic", () => {
    const e = ev("ActionEvent", { tool_name: "file_editor", action: { path: "a.ts" } });
    const copy = structuredClone(e);
    const first = translateEvent(e);
    expect(translateEvent(e)).toEqual(first);
    expect(e).toEqual(copy);
  });
});

describe("redaction cannot be bypassed by invisible characters or line breaks", () => {
  const body = "abcdefghijklmnop1234";
  const splits = ["\u200b", "\u200d", "\ufeff", "\u202e", "\u2066", "\u2069", "\u0000", "\u0085", "\n", "\r\n", "\t", "\u2028"];
  for (const sep of splits) {
    it(`redacts a token split by U+${(sep.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`, () => {
      const out = sanitizeDetail(`edit ghp_${sep}${body} now`);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain("abcdefgh");
      expect(out).not.toContain("ijklmnop");
      expect(out).not.toContain("1234");
    });
  }

  it("does not leak the tail of a token broken by a newline in the middle of the body", () => {
    expect(sanitizeDetail("ghp_abcdefgh\nijklmnop1234")).toBe("[redacted]");
  });

  it("redacts other secret kinds split across lines", () => {
    expect(sanitizeDetail("api_key=\nsupersecretvalue")).not.toContain("supersecret");
    expect(sanitizeDetail("sk-abcdefgh\u200bijklmnop")).not.toContain("ijklmnop");
  });

  it("redacts through the notification path (action.path)", () => {
    const e = ev("ActionEvent", { tool_name: "file_editor", action: { path: `ghp_\u200b${body}` } });
    const text = translateEvent(e)[0]?.text ?? "";
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(body);
  });

  it("does not over-redact ordinary multi-line text", () => {
    expect(sanitizeDetail("first line\nsecond line")).toBe("first line second line");
    expect(sanitizeDetail("risk\u200bsk-ish word")).toBe("risk sk-ish word");
  });

  it("strips bidi isolates U+2066-U+2069 to spaces", () => {
    expect(sanitizeDetail("a\u2066b\u2067c\u2068d\u2069e")).toBe("a b c d e");
  });
});

describe("malformed events never throw", () => {
  const bad: unknown[] = [null, undefined, 0, 42, "text", true, Symbol("s"), () => 1];
  for (const value of bad) {
    it(`suppresses ${typeof value === "symbol" ? "symbol" : String(value)}`, () => {
      const input = value as OpenHandsEvent;
      const result = translateWithClassification(input);
      expect(result.classification).toBe("event.suppressed");
      expect(result.reason).toBe("malformed_event");
      expect(result.notifications).toEqual([]);
      expect(translateEvent(input)).toEqual([]);
      expect(translateEvents([input, ev("PauseEvent")])).toEqual([]);
    });
  }

  it("skips malformed items inside a batch and keeps the valid ones", () => {
    const batch = [null, ev("ActionEvent", { tool_name: "think" }), undefined] as unknown as OpenHandsEvent[];
    expect(translateEvents(batch).map((x) => x.text)).toEqual(["🧠 Analizando…"]);
  });

  it("a non-array batch yields nothing", () => {
    expect(translateEvents(null as unknown as OpenHandsEvent[])).toEqual([]);
    expect(translateEvents(undefined as unknown as OpenHandsEvent[])).toEqual([]);
  });

  it("a throwing getter on a field is caught as malformed_event", () => {
    const e = ev("ActionEvent", { tool_name: "file_editor" });
    Object.defineProperty(e, "action", { get: () => { throw new Error("boom"); }, enumerable: true });
    expect(translateWithClassification(e)).toEqual({
      notifications: [],
      classification: "event.suppressed",
      reason: "malformed_event",
    });
  });

  it("a throwing kind getter is caught as malformed_event", () => {
    const e = { id: "1", timestamp: "t", source: "s" } as Record<string, unknown>;
    Object.defineProperty(e, "kind", { get: () => { throw new Error("boom"); } });
    expect(translateWithClassification(e as unknown as OpenHandsEvent).reason).toBe("malformed_event");
  });
});

describe("category collapse", () => {
  it("collapses same-category status notifications even when their text differs", () => {
    const out = translateEvents([
      ev("ActionEvent", { tool_name: "finish", action: { message: "A" } }),
      ev("ConversationStateUpdateEvent", { key: "execution_status", value: "finished" }),
    ]);
    expect(out.map((x) => x.text)).toEqual(["✅ Tarea completada: A"]);
  });

  it("collapses across batches through `previous`", () => {
    const [first] = translateEvents([ev("ActionEvent", { tool_name: "finish", action: { message: "A" } })]);
    const out = translateEvents(
      [ev("ConversationStateUpdateEvent", { key: "execution_status", value: "finished" })],
      first,
    );
    expect(out).toEqual([]);
  });

  it("does not collapse non-status categories with different text", () => {
    const out = translateEvents([
      ev("ActionEvent", { tool_name: "file_editor", action: { path: "a.ts" } }),
      ev("ActionEvent", { tool_name: "file_editor", action: { path: "b.ts" } }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("purity (no clock, randomness or I/O)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const events = (): OpenHandsEvent[] => [
    ev("ActionEvent", { tool_name: "think" }),
    ev("ActionEvent", { tool_name: "file_editor", action: { path: "src/a.ts" } }),
    ev("ActionEvent", { tool_name: "bash", summary: "run pytest -q" }),
    ev("ActionEvent", { tool_name: "finish", action: { message: "ghp_abcdefghijklmnop1234 done" } }),
    ev("ConversationStateUpdateEvent", { key: "execution_status", value: "stuck" }),
    ev("UserRejectObservation", { rejection_source: "user" }),
    ev("Mystery"),
  ];

  it("never reads the clock or randomness", () => {
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    const perf = vi.spyOn(performance, "now");
    const created = vi.spyOn(globalThis, "Date");
    translateEvents(events());
    for (const e of events()) translateWithClassification(e);
    sanitizeDetail("x\nghp_abcdefghijklmnop1234");
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(perf).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it("does not depend on or schedule fake timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const before = events();
    const a = translateEvents(before);
    vi.setSystemTime(new Date("2040-06-01T00:00:00Z"));
    vi.advanceTimersByTime(60_000);
    expect(translateEvents(before)).toEqual(a);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not touch the filesystem or network primitives", async () => {
    const { default: fs } = await import("node:fs");
    const spies = (["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "statSync", "readdirSync", "openSync"] as const).map(
      (name) => vi.spyOn(fs, name).mockImplementation(() => { throw new Error(`I/O: fs.${name}`); }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("I/O: fetch"); });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(() => translateEvents(events())).not.toThrow();
    for (const spy of [...spies, fetchSpy, log, err, out]) expect(spy).not.toHaveBeenCalled();
  });

  it("the module has no imports, so it cannot reach fs, net or the clock through a dependency", async () => {
    const { default: fs } = await import("node:fs");
    const source = fs.readFileSync(new URL("../../src/core/translate.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(|process\.|globalThis\.|new Date|Date\.now|Math\.random/);
  });

  it("same input gives deep-equal output and the input is not mutated (deep-frozen)", () => {
    const deepFreeze = <T,>(o: T): T => {
      if (typeof o === "object" && o !== null) {
        for (const v of Object.values(o)) deepFreeze(v);
        Object.freeze(o);
      }
      return o;
    };
    const input = events();
    const snapshot = structuredClone(input);
    deepFreeze(input);
    const first = translateEvents(input);
    const second = translateEvents(input);
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(translateWithClassification(input[0] as OpenHandsEvent)).toEqual(
      translateWithClassification(input[0] as OpenHandsEvent),
    );
  });
});

// Synthetic secrets are assembled at runtime so no literal credential sits in the repository.
const j = (...parts: string[]): string => parts.join("");
const GH = j("gh", "p_", "abcdefghijklmnop1234");
const ZW = "\u200b";
const toFullwidth = (s: string): string =>
  Array.from(s, (c) => (c >= "!" && c <= "~" ? String.fromCodePoint((c.codePointAt(0) ?? 0) + 0xfee0) : c)).join("");

describe("bounded cost on pathological input (F1, CR-1)", () => {
  const LIMIT_MS = 500; // linear implementation: a few ms; the quadratic one needed seconds to minutes
  const cases: Array<[string, string]> = [
    ["1e5 digits and a colon", `${"1".repeat(100_000)}:`],
    ["1e6 digits and a colon", `${"1".repeat(1_000_000)}:`],
    ["2e5 chars of repeated `token: value`", j("tok", "en: value1234 ").repeat(12_000)],
    ["2e5 chars of repeated keyword=value", j("api_", "key", "=", "abcd1234 ").repeat(12_000)],
    ["130k chars of sk- keys followed by a zero-width space", j("sk", "-ABCDEFGH", ZW, " ").repeat(10_000)],
    ["150k chars of split provider prefixes", j("ghp_ ", ZW).repeat(30_000)],
    ["repeated PEM headers", j("-----BEGIN ", "PRIVATE KEY-----").repeat(5_000)],
    ["300k whitespace then a secret", `${" ".repeat(300_000)}${GH}`],
    ["200k combining marks", `a${"\u0301".repeat(200_000)}`],
  ];
  for (const [name, input] of cases) {
    it(`sanitizeDetail stays fast and bounded: ${name}`, () => {
      const start = performance.now();
      const out = sanitizeDetail(input);
      expect(performance.now() - start).toBeLessThan(LIMIT_MS);
      expect(Array.from(out).length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH);
    });
  }

  it("5 MB summaries, finish messages and commands translate quickly through the public API", () => {
    const big = j("tok", "en: value1234 ").repeat(300_000);
    const start = performance.now();
    const a = translateEvent(ev("ActionEvent", { tool_name: "browser", summary: big }));
    const b = translateEvent(ev("ActionEvent", { tool_name: "finish", action: { message: big } }));
    const c = translateEvent(ev("ActionEvent", { tool_name: "terminal", action: { command: `${" ".repeat(5_000_000)}x` } }));
    expect(performance.now() - start).toBeLessThan(LIMIT_MS * 2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(Array.from(a[0]?.text ?? "").length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH + 20);
  });

  it("caps the input before scanning and respects a custom maxLength", () => {
    const out = sanitizeDetail("a".repeat(1_000_000));
    expect(Array.from(out)).toHaveLength(MAX_DETAIL_LENGTH);
    expect(out.endsWith("…")).toBe(true);
    expect(sanitizeDetail("abcdefghij", 5)).toBe("abcd…");
    expect(sanitizeDetail("abc", Number.NaN)).toBe("abc");
  });
});

describe("redaction covers common secret formats (F2)", () => {
  const leaks = (input: string, secret: string): void => {
    const out = sanitizeDetail(input);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(secret);
  };

  it("environment assignments whose name ends in _API_KEY or _SECRET_ACCESS_KEY", () => {
    leaks(j("OPENAI_API", "_KEY", "=", "abcd1234efgh5678"), "abcd1234efgh5678");
    leaks(j("export AWS_SECRET", "_ACCESS_KEY", "=", "wJalr1234567890abcdEFGH"), "wJalr1234567890abcdEFGH");
    leaks(j("GITHUB_TOK", "EN", "=", "plainvalue99"), "plainvalue99");
  });

  it("JSON-quoted keys with quoted values", () => {
    leaks(j('{"pass', 'word":', '"hunter2secret"}'), "hunter2secret");
    leaks(j('{"tok', 'en": ', '"abc123def456"}'), "abc123def456");
    leaks(j('{"X-Session-', 'API-Key": ', '"abc123def456"}'), "abc123def456");
    leaks(j("X-Session-", "API-Key", ": abc123def456"), "abc123def456");
  });

  it("space separated forms", () => {
    leaks(j("x-session-", "api-key", " abc123def456ghi"), "abc123def456ghi");
    leaks(j("the pass", "word is hunter2secret ok"), "hunter2secret");
  });

  it("the whole Authorization header, scheme and credentials", () => {
    expect(sanitizeDetail(j("Authori", "zation: Basic dXNlcjpwYXNzd29yZA=="))).toBe("[redacted]");
    leaks(j("Authori", "zation: Bearer abcdefgh12345678"), "abcdefgh12345678");
    leaks(j("curl -H 'authori", "zation: token ghx12345678'"), "ghx12345678");
    leaks("sent Basic dXNlcjpwYXNzd29yZA== to host", "dXNlcjpwYXNz");
  });

  it("Telegram bot tokens inside URLs and bare", () => {
    const secret = `${"A".repeat(10)}${"b1".repeat(12)}-_${"Z".repeat(3)}`;
    leaks(`https://api.telegram.org/bot123456789:${secret}/getMe`, secret);
    leaks(`123456789:${secret}`, secret);
  });

  it("AWS access key ids, also with a letter before them", () => {
    const id = j("AK", "IA", "ABCDEFGHIJKLMNOP");
    leaks(`id ${id} end`, id);
    leaks(`x${id}`, id);
  });

  it("PEM private key blocks, complete or truncated", () => {
    const begin = j("-----BEGIN ", "RSA PRIVATE", " KEY-----");
    const end = j("-----END ", "RSA PRIVATE", " KEY-----");
    const pem = `${begin}\nMIIEowIBAAKCAQEA1234\nabcdEFGH5678\n${end}`;
    expect(sanitizeDetail(`key: ${pem} after`)).toBe("key: [redacted] after");
    leaks(`${begin}\nMIIEvQIBADANBgkqhkiG`, "MIIEvQIBADANBgkq");
  });

  it("does not double-redact an already redacted value", () => {
    expect(sanitizeDetail("[redacted]")).toBe("[redacted]");
    expect(sanitizeDetail(j("pass", "word", "=", "[redacted]"))).toBe(j("pass", "word", "=", "[redacted]"));
  });
});

describe("redaction survives look-alike and invisible encodings (F3)", () => {
  const body = "abcdefghijklmnop1234";
  const variants: Array<[string, string]> = [
    ["plain space after the separator", `ghp_ ${body}`],
    ["space before the separator", `ghp _${body}`],
    ["U+2010 hyphen as the separator", `glpat\u2010${body}`],
    ["U+034F combining grapheme joiner", `ghp_\u034f${body}`],
    ["combining mark inside the body", "ghp_abcdefgh\u0301ijklmnop1234"],
    ["U+E0020 tag character", `ghp_\u{e0020}${body}`],
    ["U+3164 Hangul filler", `ghp_\u3164${body}`],
    ["fullwidth prefix", toFullwidth("ghp_") + body],
    ["fullwidth everything", toFullwidth(`ghp_${body}`)],
  ];
  for (const [name, input] of variants) {
    it(`redacts: ${name}`, () => {
      const out = sanitizeDetail(`edit ${input} now`);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain("abcdefgh");
      expect(out).not.toContain("ijklmnop");
      expect(out).not.toContain("1234");
    });
  }

  it("normalises compatibility characters and keeps accented text intact", () => {
    expect(sanitizeDetail("cafe\u0301 \ufb01le")).toBe("caf\u00e9 file");
  });
});

describe("redaction does not eat ordinary names and prose (CR-4)", () => {
  it("keeps file names and prose that only look like keys", () => {
    for (const s of [
      "src/sk-utils-helper.ts",
      "pk_migration_helper.py",
      "src/sk-abcdefghijklmnop1234.ts",
      "ask-abcdefghijklmnop1234",
      j("fix tok", "en: handling in auth"),
      j("my tok", "en: is great and the sec", "ret: sauce"),
      "basic configuration for the build",
      "git commit abcdef0123456789abcdef0123456789abcdef01",
    ]) {
      expect(sanitizeDetail(s)).toBe(s);
    }
  });

  it("still redacts genuine keys next to the same words", () => {
    expect(sanitizeDetail("use sk-abcdefghijklmnop1234 here")).toBe("use [redacted] here");
    expect(sanitizeDetail("use sk-proj-Ab12Cd34Ef56Gh78 here")).toBe("use [redacted] here");
    expect(sanitizeDetail(j("tok", "en: abc123def456"))).toBe("[redacted]");
    expect(sanitizeDetail(j("pass", "word: hunter2secret"))).toBe("[redacted]");
  });

  it("shows a file edit with an sk- looking name in the notification", () => {
    const e = ev("ActionEvent", { tool_name: "file_editor", action: { path: "src/sk-utils-helper.ts" } });
    expect(texts([e])).toEqual(["🔧 Modificando: src/sk-utils-helper.ts"]);
  });

  describe("word boundary guard on split secrets", () => {
    it("redacts a key split by an invisible character when it starts a word", () => {
      expect(sanitizeDetail(`see sk-abcdefgh${ZW}ijklmnop1234`)).toBe("see [redacted]");
      expect(sanitizeDetail(`see${ZW}sk-abcdefghijklmnop1234`)).toBe("see [redacted]");
    });
    it("leaves 'sk-' inside a longer word alone; an invisible character counts as a word break", () => {
      expect(sanitizeDetail(`risk${ZW}sk-ish word`)).toBe("risk sk-ish word");
      expect(sanitizeDetail("task-abcdefghijklmnop1234")).toBe("task-abcdefghijklmnop1234");
      expect(sanitizeDetail(`ta${ZW}sk-abcdefghijklmnop1234`)).toBe("ta [redacted]"); // output shows a space: a new word
    });
    it("replaces exactly the secret span, not its neighbours", () => {
      expect(sanitizeDetail(`a ${GH.slice(0, 8)}${ZW}${GH.slice(8)} b`)).toBe("a [redacted] b");
    });
  });
});

describe("completion is order independent (CR-5)", () => {
  const finished = (): OpenHandsEvent => ev("ConversationStateUpdateEvent", { key: "execution_status", value: "finished" });
  const finish = (): OpenHandsEvent => ev("ActionEvent", { tool_name: "finish", action: { message: "Done: fixed X" } });

  it("status first, then finish with a summary: the summary wins", () => {
    expect(texts([finished(), finish()])).toEqual(["✅ Tarea completada: Done: fixed X"]);
  });

  it("finish first, then status: one message with the summary", () => {
    expect(texts([finish(), finished()])).toEqual(["✅ Tarea completada: Done: fixed X"]);
  });

  it("across batches the richer message is emitted after the bare one and then collapses", () => {
    const first = translateEvents([finished()]);
    const second = translateEvents([finish(), finished()], first.at(-1));
    expect(second.map((x) => x.text)).toEqual(["✅ Tarea completada: Done: fixed X"]);
    expect(translateEvents([finished()], second.at(-1))).toEqual([]);
  });

  it("a different later summary is not replaced by another one", () => {
    const other = ev("ActionEvent", { tool_name: "finish", action: { message: "Second" } });
    expect(texts([finish(), other])).toEqual(["✅ Tarea completada: Done: fixed X"]);
  });
});

describe("final review round (N1, N2, N4, P11, CR-10)", () => {
  const hidden = (input: string, secret: string): void => {
    const out = sanitizeDetail(input, 4096);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(secret);
  };

  it("a repeated keyword stays linear at the largest maxLength", () => {
    const input = j("tok", "en").repeat(13_000);
    const start = performance.now();
    sanitizeDetail(input, 4096);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("redacts unquoted name:value", () => {
    hidden(j("api_", "key", ":abcd1234efgh"), "abcd1234efgh");
    hidden(j("tok", "en:Zx9Qw7Lm2Pq"), "Zx9Qw7Lm2Pq");
  });

  it("redacts quoted values that contain spaces completely", () => {
    for (const input of [
      j("pass", 'word="correct horse battery staple"'),
      j("pass", "word='correct horse battery staple'"),
      j('"pass', 'word": "a b c d"'),
      j("API_", "KEY", '="alpha beta gamma"'),
    ]) {
      // A JSON key keeps its opening quote; everything else, spaces included, is gone.
      expect(sanitizeDetail(input, 4096).replace(/^"/, "")).toBe("[redacted]");
    }
    expect(sanitizeDetail(j("pass", 'word="correct horse" and then more words'))).toBe("[redacted] and then more words");
  });

  it("redacts URL userinfo, curl -u and cookies", () => {
    hidden("clone https://deploy:hunter2pw@example.com/repo.git now", "hunter2pw");
    hidden("curl -s -u admin:hunter2pw https://example.com/api", "hunter2pw");
    hidden("curl --user admin:hunter2pw https://example.com/api", "hunter2pw");
    hidden("Cookie: sid=abc123def456; theme=dark", "abc123def456");
    hidden("Set-Cookie: auth=Zx9Qw7Lm2Pq; Path=/", "Zx9Qw7Lm2Pq");
    hidden("session=abcd1234efgh5678 expired", "abcd1234efgh5678");
  });

  it("does not over-redact look-alikes", () => {
    for (const text of [
      "see https://example.com:8080/path/a@b",
      "open http://localhost:3000/ui",
      "curl -u admin https://example.com",
      "curl -s https://example.com/health",
      "the Cookie: banner is shown",
      "session=active and session expired",
      "ssh://github.com:22/org/repo.git",
    ]) {
      expect(sanitizeDetail(text)).toBe(text);
    }
  });

  it("does not leave half a surrogate pair when cutting at the cap", () => {
    const input = `x${" ".repeat(158)}😀tail`; // high surrogate exactly at index cap - 1 for maxLength 10
    const out = sanitizeDetail(input, 10);
    expect(out).toBe("x");
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  });
});
