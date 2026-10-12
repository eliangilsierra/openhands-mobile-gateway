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
 * Redaction is best-effort pattern matching on known secret shapes. Deliberate exfiltration by an
 * adversarial agent (base64, percent-encoding, `\u` escapes, splitting a secret over arbitrary
 * words) is out of scope: nobody may rely on this module as a data-loss-prevention control.
 *
 * Cost model: every untrusted string is cut to a fixed multiple of the output length BEFORE any
 * regular expression runs, and no pattern has an unbounded nested quantifier, so the work per
 * call is linear in a small constant (no event can stall the single-threaded Gateway).
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

const REDACTED = "[redacted]";

/** Case-insensitive literal without the `i` flag (so character classes elsewhere stay exact). */
function ci(word: string): string {
  return word.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

const VALUE = `[^\\s"',}]`;
const NOT_YET_REDACTED = `(?!\\[redacted\\])`;
// Bounded: an unbounded tail makes a repeated keyword (tokentokentoken...) quadratic.
const NAME_TAIL = `[A-Za-z0-9_.-]{0,64}`;
const KEYWORD =
  `(?:${ci("api")}[_-]?${ci("key")}|${ci("token")}|${ci("secret")}|${ci("passw")}(?:${ci("or")})?${ci("d")}` +
  `|${ci("authorization")}|${ci("credential")}|${ci("session")}[_-]?${ci("key")}|${ci("private")}[_-]?${ci("key")})`;
// Prose such as "fix token: handling in auth" must survive: after "key: " an unquoted value must
// look like a secret (digit or symbol, or a long run) before it is redacted.
const SECRET_LOOKING = `(?:(?=[^\\s"',}]*[0-9!#$%&()*+/;<>?@\\[\\]^\`{|~])|(?=[^\\s"',}]{20}))`;
const NOT_WORD_BEFORE = `(?<![A-Za-z0-9_])`;

const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private key block (to its END line, or to the end of the text when truncated).
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
  // Authorization header or assignment, scheme included.
  new RegExp(
    `${ci("authorization")}["']?[ \\t]*[=:][ \\t]*["']?(?:(?:${ci("bearer")}|${ci("basic")}|${ci("token")}|${ci("digest")})[ \\t]+)?` +
      `${NOT_YET_REDACTED}${VALUE}{4,}`,
    "g",
  ),
  new RegExp(`${NOT_WORD_BEFORE}${ci("bearer")}\\s+[A-Za-z0-9._~+/=-]{8,}`, "g"),
  new RegExp(`${NOT_WORD_BEFORE}${ci("basic")}\\s+(?=[A-Za-z0-9+/]*[0-9=+/])[A-Za-z0-9+/]{8,}={0,2}`, "g"),
  // JWT.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  // Distinctive provider prefixes; a space around the separator ("ghp_ abc") is tolerated.
  /(?<![A-Za-z0-9_])(?:ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs])[ \t]{0,3}[-_][ \t]{0,3}[A-Za-z0-9_-]{8,}/g,
  // sk-/pk- keys: not inside words or paths, and not kebab/snake_case words (sk-utils-helper).
  /(?<![A-Za-z0-9_./\\-])(?:sk|pk)[-_](?![a-z]+(?:[-_][a-z]+)+(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}/g,
  // Telegram bot token (also inside https://api.telegram.org/bot<id>:<secret>/...).
  /(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  // name=value, "name": "value", name:value and "name: value" with a secret-looking value;
  // the name may carry any prefix/suffix (OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY, the gateway session key header).
  // Quoted values may contain spaces: redact up to the closing quote (must precede the generic forms).
  new RegExp(`${KEYWORD}${NAME_TAIL}["']?[ \\t]*[=:][ \\t]*"${NOT_YET_REDACTED}[^"]{4,256}"`, "g"),
  new RegExp(`${KEYWORD}${NAME_TAIL}["']?[ \\t]*[=:][ \\t]*'${NOT_YET_REDACTED}[^']{4,256}'`, "g"),
  // URL userinfo (scheme://user:pw@host): only the credentials are replaced.
  /(?<=[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/)[^\s:/?#@"']{1,64}:[^\s/?#"']{1,128}@/g,
  // curl -u user:pw / --user user:pw.
  /\bcurl\b[^\n|;&]{0,200}?[ \t](?:-u|--user)[ \t]+[^\s:]{1,64}:\S{1,128}/g,
  // Cookie / Set-Cookie header values (name=value pairs) and session ids that contain a digit.
  new RegExp(`${ci("cookie")}[ \\t]*:[ \\t]*${NOT_YET_REDACTED}(?:[A-Za-z0-9_.-]{1,64}=[^\\s;"']{1,512}(?:;[ \\t]*)?){1,16}`, "g"),
  new RegExp(
    `${NOT_WORD_BEFORE}${ci("session")}(?:[_-]?${ci("id")})?[ \\t]*=[ \\t]*${NOT_YET_REDACTED}(?=[^\\s"',}]*[0-9])${VALUE}{8,}`,
    "g",
  ),
  new RegExp(`${KEYWORD}${NAME_TAIL}["']?[ \\t]*=[ \\t]*["']?${NOT_YET_REDACTED}${VALUE}{4,}`, "g"),
  new RegExp(`${KEYWORD}${NAME_TAIL}["']?[ \\t]*:[ \\t]*["']${NOT_YET_REDACTED}${VALUE}{4,}`, "g"),
  new RegExp(`${KEYWORD}${NAME_TAIL}["']?:${NOT_YET_REDACTED}[^\\s"',}:]{4,}`, "g"),
  new RegExp(`${KEYWORD}${NAME_TAIL}["']?[ \\t]*:[ \\t]+${NOT_YET_REDACTED}${SECRET_LOOKING}${VALUE}{6,}`, "g"),
  // Space separated forms.
  new RegExp(`${ci("x")}-${ci("session")}-${ci("api")}-${ci("key")}[ \\t]+${NOT_YET_REDACTED}${VALUE}{8,}`, "g"),
  new RegExp(`${ci("passw")}(?:${ci("or")})?${ci("d")}[ \\t]+${ci("is")}[ \\t]+${NOT_YET_REDACTED}${VALUE}{6,}`, "g"),
];

// Characters that carry no visible content and are used to hide secrets. They are removed to
// DETECT a secret; in the output the "formatting" and control ones become a space.
// Marks, tag characters and Hangul/halfwidth fillers: dropped from the output.
const STRIP_CHARS = /[\p{Mn}\u{e0000}-\u{e007f}\u115f\u1160\u3164\uffa0]/gu;
// Format characters (zero-width, bidi marks/overrides/isolates, BOM, soft hyphen, ...): a space.
const INVISIBLE_CHARS = /\p{Cf}/gu;
// C0/C1 controls, DEL and line/paragraph separators: a space.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const HIDING_CHARS = new RegExp(`${STRIP_CHARS.source}|${INVISIBLE_CHARS.source}|${CONTROL_CHARS.source}`, "u");
// Unicode dashes that NFKC leaves alone; only treated as "-" while looking for a secret.
const DASH_CHARS = /[\u2010-\u2015\u2212\u2043\ufe58\ufe63]/u;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Redacts secrets that were split by invisible characters, controls or line breaks, or written
 * with look-alike dashes: the text is rejoined only to find the secret, and the whole original
 * span (separators included) is replaced. One pass, linear in the input length.
 */
function redactSplitSecrets(value: string): string {
  const kept: string[] = [];
  const origin: number[] = []; // index in `value` of each UTF-16 unit kept in `text`
  let offset = 0;
  for (const ch of value) {
    if (!HIDING_CHARS.test(ch)) {
      const mapped = DASH_CHARS.test(ch) ? "-" : ch;
      for (let k = 0; k < mapped.length; k += 1) {
        kept.push(mapped.charAt(k));
        origin.push(offset + k);
      }
    }
    offset += ch.length;
  }
  const text = kept.join("");
  const ranges: Array<[number, number]> = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      if (m[0].length === 0) continue;
      const from = origin[m.index];
      const last = origin[m.index + m[0].length - 1];
      if (from === undefined || last === undefined) continue;
      const to = last + 1;
      // Identical in the original: the ordinary pass after cleaning redacts it.
      if (value.slice(from, to) === m[0]) continue;
      ranges.push([from, to]);
    }
  }
  if (ranges.length === 0) return value;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const pieces: string[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from < cursor) continue; // overlaps a span already replaced
    pieces.push(value.slice(cursor, from), REDACTED);
    cursor = to;
  }
  pieces.push(value.slice(cursor));
  return pieces.join("");
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
  // Redact BEFORE cleaning so invisible characters and line breaks cannot hide a secret.
  const stripped = redactSplitSecrets(normalised);
  const text = redact(
    stripped
      .replace(STRIP_CHARS, "")
      .replace(INVISIBLE_CHARS, " ")
      .replace(CONTROL_CHARS, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
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
