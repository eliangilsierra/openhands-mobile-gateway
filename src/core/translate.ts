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
// Invisible formatting characters (zero-width, bidi marks/overrides/isolates, BOM, soft hyphen):
// replaced by a space; the joined-text check in sanitizeDetail catches secrets split by them.
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// C0/C1 controls, DEL and line/paragraph separators: replaced by a space.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

// Same patterns without the leading word boundary: boundaries are checked on the original text.
const JOINED_PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map(
  (p) => new RegExp(p.source.replace(/^\\b/, ""), p.flags),
);
const HIDING_CHARS = new RegExp(`${INVISIBLE_CHARS.source}|${CONTROL_CHARS.source}`);

/**
 * Redacts secrets that were split by invisible characters, controls or line breaks: the pieces are
 * rejoined only to find the secret, and the whole original span (separators included) is replaced.
 */
function redactSplitSecrets(value: string): string {
  const joined: string[] = [];
  const origin: number[] = []; // index in `value` of each char kept in `joined`
  const chars = Array.from(value);
  let offset = 0;
  const starts: number[] = [];
  for (const ch of chars) {
    starts.push(offset);
    if (!HIDING_CHARS.test(ch)) {
      joined.push(ch);
      origin.push(offset);
    }
    offset += ch.length;
  }
  const text = joined.join("");
  const ranges: Array<[number, number]> = [];
  for (const pattern of JOINED_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const from = origin[Array.from(text.slice(0, m.index)).length];
      const lastChar = origin[Array.from(text.slice(0, m.index + m[0].length)).length - 1];
      if (from === undefined || lastChar === undefined) continue;
      const to = lastChar + 1;
      const prev = value.slice(0, from).replace(new RegExp(`(?:${HIDING_CHARS.source})+$`), "").slice(-1);
      const spansHidden = Array.from(value.slice(from, to)).some((c) => HIDING_CHARS.test(c));
      if (spansHidden && !/\w/.test(prev)) ranges.push([from, to]);
    }
  }
  ranges.sort((x, y) => y[0] - x[0]);
  let out = value;
  let limit = Infinity;
  for (const [from, to] of ranges) {
    if (to > limit) continue; // overlaps a range already replaced
    out = `${out.slice(0, from)}${REDACTED}${out.slice(to)}`;
    limit = from;
  }
  return out;
}

/** Makes untrusted text safe to embed in a one-line notification. */
export function sanitizeDetail(value: string, maxLength: number = MAX_DETAIL_LENGTH): string {
  // Redact BEFORE cleaning so invisible characters and line breaks cannot hide a secret.
  const stripped = redactSplitSecrets(value);
  const text = redact(
    stripped.replace(INVISIBLE_CHARS, " ").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim(),
  );
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

const SUPPRESSED_MALFORMED: TranslationResult = {
  notifications: [],
  classification: "event.suppressed",
  reason: "malformed_event",
};

/** Translates one event. Never throws: malformed or unknown events are suppressed. */
export function translateWithClassification(event: OpenHandsEvent): TranslationResult {
  if (typeof event !== "object" || event === null) return SUPPRESSED_MALFORMED;
  let kind: string;
  let notifications: Notification[];
  try {
    kind = typeof event.kind === "string" ? event.kind : "";
    const handler = Object.hasOwn(HANDLERS, kind) ? HANDLERS[kind] : undefined;
    if (handler === undefined) {
      return { notifications: [], classification: "event.suppressed", reason: "unknown_kind" };
    }
    notifications = handler(event);
  } catch {
    return SUPPRESSED_MALFORMED;
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
  if (!Array.isArray(events)) return out;
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
