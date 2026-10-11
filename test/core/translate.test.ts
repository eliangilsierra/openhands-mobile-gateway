import { describe, expect, it } from "vitest";
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
