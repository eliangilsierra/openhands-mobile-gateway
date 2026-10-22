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
 *
 * Secret redaction lives in `./redact.ts` (best-effort pattern matching, with its accepted
 * limitations documented there and in the README); this module only caps, normalises and truncates.
 *
 * Cost model: every untrusted string is cut to a fixed multiple of the output length BEFORE any
 * regular expression runs, and no pattern has an unbounded nested quantifier, so the work per
 * call is linear in a small constant (no event can stall the single-threaded Gateway).
 */

import { redactDetail } from "./redact.js";

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
  /** Plain text, never markup: the channel adapter MUST escape it for its own parse mode. */
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

/** Input is cut to `maxLength * INPUT_FACTOR` UTF-16 units before any scanning. */
const INPUT_FACTOR = 16;
const MAX_LENGTH_CEILING = 4096;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Makes untrusted text safe to embed in a one-line notification. */
export function sanitizeDetail(value: string, maxLength: number = MAX_DETAIL_LENGTH): string {
  const limit = Number.isFinite(maxLength)
    ? Math.min(Math.max(Math.floor(maxLength), 1), MAX_LENGTH_CEILING)
    : MAX_DETAIL_LENGTH;
  const cap = limit * INPUT_FACTOR;
  // Cut FIRST (before normalisation and every regex), then canonicalise: NFKC folds fullwidth and
  // compatibility letters onto ASCII so they cannot dodge the patterns.
  const normalised = cutUnits(cutUnits(value, cap).normalize("NFKC"), cap);
  // Secrets are redacted BEFORE the cleanup so invisible characters and line breaks cannot hide them.
  const text = redactDetail(normalised);
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
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
const COMPLETED_TEXT = "✅ Tarea completada";

function targetFile(event: OpenHandsEvent): string | undefined {
  const action = rec(event["action"]);
  const path = str(action?.["path"]) ?? str(action?.["file_path"]);
  return path === undefined ? undefined : sanitizeDetail(path);
}

function commandText(event: OpenHandsEvent): string {
  const action = rec(event["action"]);
  // Bounded: the heuristic only needs the start of the command line.
  return [str(event["summary"]), str(action?.["command"])]
    .filter((s): s is string => s !== undefined)
    .map((s) => s.slice(0, MAX_DETAIL_LENGTH * INPUT_FACTOR))
    .join(" ");
}

function translateAction(event: OpenHandsEvent): Notification[] {
  const tool = (str(event["tool_name"]) ?? "").toLowerCase();
  const summary = str(event["summary"]);
  if (THINK_TOOLS.has(tool)) return [note("thinking", "🧠 Analizando…")];
  if (FINISH_TOOLS.has(tool)) {
    const message = str(rec(event["action"])?.["message"]) ?? summary;
    const detail = message === undefined ? "" : sanitizeDetail(message);
    return [note("completed", detail === "" ? COMPLETED_TEXT : `${COMPLETED_TEXT}: ${detail}`, "info", true)];
  }
  // An edit whose summary merely mentions a runner ("Update jest config") is still an edit.
  if (!EDIT_TOOLS.has(tool) && TEST_COMMAND.test(commandText(event))) return [note("testing", "🧪 Ejecutando tests…")];
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
      return [note("completed", COMPLETED_TEXT, "info", true)];
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
  // Architecture §12: task failure is derived from the conversation status (`error`, handled in
  // translateStateUpdate). An AgentErrorEvent is an error reported back to the agent for one
  // tool call, which it can recover from, so it is a non-terminal warning (no error body shown).
  AgentErrorEvent: () => [note("tool", "⚠️ Una herramienta devolvió un error", "warning")],
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
 * text otherwise). `previous` lets the caller carry the last notification across batches; the
 * caller must reset it (leave it undefined) when a new task starts.
 *
 * Completion is order independent: a bare "Tarea completada" (status update) followed by the
 * `finish` action with a summary is upgraded to the summary (replacing the bare one when it is
 * still in this batch, otherwise emitted after it); a bare one after a summary is dropped.
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
      if (last !== undefined && last.category === "completed" && n.category === "completed") {
        if (last.text === COMPLETED_TEXT && n.text !== COMPLETED_TEXT) {
          if (out.at(-1) === last) out[out.length - 1] = n;
          else out.push(n);
          last = n;
        }
        continue;
      }
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
