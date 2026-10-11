/**
 * Event Translator (architecture §6, §7.5, FR-2, NFR-8). Pure and channel-neutral: no I/O, no
 * clock, no randomness, no Telegram types. Maps one raw OpenHands event to zero or more
 * human-friendly notifications.
 *
 * Input shape: until the Event subscriber (#12) publishes event types, the minimal envelope of
 * §7.5 is declared here (`id`, `timestamp`, `source`, `parent_id`, `kind`). Per-tool payload
 * fields are unverified (§20, R2-U1), so `summary` and `tool_name` are the primary source and
 * any other field is read defensively as `unknown`.
 *
 * Output text is plain text: control characters are stripped, whitespace collapsed, secrets
 * redacted and length bounded. The channel adapter owns markup escaping for its own format.
 */

export interface OpenHandsEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly source: string;
  readonly parent_id?: string | null;
  /** Discriminator equal to the upstream Python class name. */
  readonly kind: string;
  readonly [key: string]: unknown;
}

export type NotificationCategory =
  | "thinking"
  | "editing"
  | "tool"
  | "testing"
  | "waiting"
  | "completed"
  | "failed"
  | "stuck"
  | "denied"
  | "generic";

export interface Notification {
  readonly text: string;
  readonly category: NotificationCategory;
  readonly severity: "info" | "warning" | "error";
  /** True when the task will not progress further without the user (done, failed, stuck). */
  readonly terminal: boolean;
}

export interface TranslationResult {
  readonly notifications: readonly Notification[];
  /** What the caller should log: `event.translated` or `event.suppressed`. */
  readonly classification: "event.translated" | "event.suppressed";
  readonly reason: string;
}

export const MAX_DETAIL_LENGTH = 120;

const REDACTED = "[redacted]";
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
// C0/C1 controls, DEL, bidi overrides/isolates, zero-width and line/paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Makes untrusted text safe to embed in a one-line notification. */
export function sanitizeDetail(value: string, maxLength: number = MAX_DETAIL_LENGTH): string {
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, REDACTED);
  text = text.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : text;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function rec(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function note(
  category: NotificationCategory,
  text: string,
  severity: Notification["severity"] = "info",
  terminal = false,
): Notification {
  return { text, category, severity, terminal };
}

const THINK_TOOLS = new Set(["think", "thinking", "reasoning"]);
const FINISH_TOOLS = new Set(["finish"]);
const EDIT_TOOLS = new Set([
  "str_replace_editor",
  "file_editor",
  "str_replace_based_edit_tool",
  "edit",
  "write",
  "create_file",
  "apply_patch",
]);
const TEST_COMMAND =
  /\b(?:pytest|vitest|jest|mocha|tox|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|(?:npm|yarn|pnpm)\s+(?:run\s+)?test)\b/i;

function targetFile(event: OpenHandsEvent): string | undefined {
  const action = rec(event["action"]);
  const path = str(action?.["path"]) ?? str(action?.["file_path"]);
  return path === undefined ? undefined : sanitizeDetail(path);
}

function commandText(event: OpenHandsEvent): string {
  const action = rec(event["action"]);
  return [str(event["summary"]), str(action?.["command"])].filter(Boolean).join(" ");
}

function translateAction(event: OpenHandsEvent): Notification[] {
  const tool = (str(event["tool_name"]) ?? "").toLowerCase();
  const summary = str(event["summary"]);
  if (THINK_TOOLS.has(tool)) return [note("thinking", "🧠 Analizando…")];
  if (FINISH_TOOLS.has(tool)) {
    const message = str(rec(event["action"])?.["message"]) ?? summary;
    const detail = message === undefined ? "" : sanitizeDetail(message);
    return [note("completed", detail === "" ? "✅ Tarea completada" : `✅ Tarea completada: ${detail}`, "info", true)];
  }
  if (TEST_COMMAND.test(commandText(event))) return [note("testing", "🧪 Ejecutando tests…")];
  if (EDIT_TOOLS.has(tool)) {
    const detail = targetFile(event) ?? (summary === undefined ? undefined : sanitizeDetail(summary));
    return [note("editing", detail === undefined || detail === "" ? "🔧 Modificando archivos" : `🔧 Modificando: ${detail}`)];
  }
  const detail = summary ?? str(event["tool_name"]);
  const safe = detail === undefined ? "" : sanitizeDetail(detail);
  return [note("tool", safe === "" ? "🔧 Ejecutando una herramienta" : `🔧 Ejecutando: ${safe}`)];
}

function translateStateUpdate(event: OpenHandsEvent): Notification[] {
  if (str(event["key"]) !== "execution_status") return [];
  switch (str(event["value"])) {
    case "finished":
      return [note("completed", "✅ Tarea completada", "info", true)];
    case "error":
      return [note("failed", "💥 La tarea falló", "error", true)];
    case "stuck":
      return [note("stuck", "🧱 El agente está atascado", "warning", true)];
    case "waiting_for_confirmation":
      return [note("waiting", "⏳ Esperando tu confirmación", "warning")];
    default:
      return [];
  }
}

type Handler = (event: OpenHandsEvent) => Notification[];

const HANDLERS: Readonly<Record<string, Handler>> = {
  ActionEvent: translateAction,
  AgentErrorEvent: () => [note("failed", "💥 La tarea falló", "error", true)],
  UserRejectObservation: (event) =>
    str(event["rejection_source"]) === "user" ? [note("denied", "❌ Acción denegada", "warning")] : [],
  ConversationStateUpdateEvent: translateStateUpdate,
  // Known but deliberately silent (FR-2: not a firehose).
  ObservationEvent: () => [],
  MessageEvent: () => [],
  SystemPromptEvent: () => [],
  PauseEvent: () => [],
  Condensation: () => [],
};

/** Translates one event. Never throws: malformed or unknown events are suppressed. */
export function translateWithClassification(event: OpenHandsEvent): TranslationResult {
  const kind = typeof event.kind === "string" ? event.kind : "";
  const handler = Object.hasOwn(HANDLERS, kind) ? HANDLERS[kind] : undefined;
  if (handler === undefined) {
    return { notifications: [], classification: "event.suppressed", reason: "unknown_kind" };
  }
  let notifications: Notification[];
  try {
    notifications = handler(event);
  } catch {
    return { notifications: [], classification: "event.suppressed", reason: "malformed_event" };
  }
  return notifications.length > 0
    ? { notifications, classification: "event.translated", reason: kind }
    : { notifications: [], classification: "event.suppressed", reason: "low_signal" };
}

export function translateEvent(event: OpenHandsEvent): Notification[] {
  return [...translateWithClassification(event).notifications];
}

const COLLAPSE_BY_CATEGORY: ReadonlySet<NotificationCategory> = new Set([
  "thinking",
  "testing",
  "waiting",
  "completed",
  "failed",
  "stuck",
]);

/**
 * Translates an ordered batch and drops repeats so a burst yields one message: a notification is
 * suppressed when it repeats the previous one (same category for status-like categories, same
 * text otherwise). `previous` lets the caller carry the last notification across batches.
 */
export function translateEvents(
  events: readonly OpenHandsEvent[],
  previous?: Notification,
): Notification[] {
  const out: Notification[] = [];
  let last = previous;
  for (const event of events) {
    for (const n of translateEvent(event)) {
      const repeat =
        last !== undefined &&
        last.category === n.category &&
        (COLLAPSE_BY_CATEGORY.has(n.category) || last.text === n.text);
      if (!repeat) {
        out.push(n);
        last = n;
      }
    }
  }
  return out;
}
