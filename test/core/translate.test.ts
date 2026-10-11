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

  it("AgentErrorEvent -> failure without leaking the error body", () => {
    const e = ev("AgentErrorEvent", { error: "Traceback with token=abc123456789" });
    const [out] = translateEvent(e);
    expect(out).toMatchObject({ text: "💥 La tarea falló", severity: "error", terminal: true });
    expect(JSON.stringify(out)).not.toContain("abc123456789");
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
