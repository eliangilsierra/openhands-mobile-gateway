/**
 * Secret redaction for notification text (architecture §6, NFR-8). Pure: no I/O, no clock.
 *
 * Redaction is best-effort pattern matching on known secret shapes and on the common transport
 * encodings of text (JSON string escapes, percent-encoding of `: / @ =`, invisible characters,
 * combining marks, compatibility forms). Deliberate exfiltration by an adversarial agent (base64,
 * arbitrary encodings, splitting a secret over arbitrary words) is out of scope: nobody may rely on
 * this module as a data-loss-prevention control.
 *
 * Accepted limitations (also listed in the README), all of them ambiguous with ordinary text:
 * - URL userinfo: a password that contains a space or a quote ends the URL token there, so the
 *   part after the space/quote is not recognised as a password.
 * - URL userinfo: a password made only of 1-5 digits (value up to 65535) followed by '/', '?' or '#'
 *   is read as a port (`host:8080/path/a@b`), and a password holding both an '@' and a later
 *   '/', '?' or '#' is cut at the last '@' before that delimiter, as a URL parser reads it.
 * - Only the encodings listed above are decoded; double encoding (`%2540`) is not.
 *
 * Cost model: callers cut untrusted text to a fixed size BEFORE calling in (see `sanitizeDetail`),
 * no pattern has an unbounded nested quantifier and the scanners keep monotone cursors, so the work
 * is linear in the input length (the test suite pins this at 100k and 500k units).
 */

export const REDACTED = "[redacted]";

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
// One cookie value: quoted (spaces and ';' allowed inside) or a bare run; a lone opening quote
// (truncated text) still redacts the run after it.
const COOKIE_VALUE = `(?:"[^"]{1,512}"|["']?[^\\s;"']{1,512})`;

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
  // curl -u user:pw, -uuser:pw, -su user:pw, -u :pw, --user user:pw, --user=user:pw (the flag may
  // sit in a cluster of up to 16 letters, and the user part may be empty).
  /\bcurl\b[^\n|;&]{0,200}?[ \t](?:-[A-Za-z]{0,16}u[ \t]*|--user(?:=|[ \t]+))[^\s:]{0,64}:\S{1,128}/g,
  // Cookie / Set-Cookie header values (name=value pairs, values may be quoted) and session ids
  // that contain a digit.
  new RegExp(
    `${ci("cookie")}[ \\t]*:[ \\t]*${NOT_YET_REDACTED}(?:[A-Za-z0-9_.-]{1,64}=${COOKIE_VALUE}(?:;[ \\t]*)?){1,16}`,
    "g",
  ),
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
// Tag characters and Hangul/halfwidth fillers, and the braille blank U+2800: dropped from the
// output. Combining marks are NOT here: they are legitimate text (Hindi, Thai, Arabic harakat)
// and stay in the output; only the detection copy ignores them.
export const STRIP_CHARS = /[\u{e0000}-\u{e007f}\u115f\u1160\u3164\uffa0\u2800]/gu;
// Format characters (zero-width, bidi marks/overrides/isolates, BOM, soft hyphen, ...): a space.
export const INVISIBLE_CHARS = /\p{Cf}/gu;
// C0/C1 controls, DEL and line/paragraph separators: a space.
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
// Lone surrogates (never valid text; a paired surrogate is one code point in `u` mode): a space.
export const LONE_SURROGATES = /\p{Cs}/gu;
// What the detection copy ignores: everything above plus all combining marks (\p{M}: Mn, Mc, Me).
const HIDING_CHARS = new RegExp(
  `\\p{M}|${STRIP_CHARS.source}|${INVISIBLE_CHARS.source}|${CONTROL_CHARS.source}|${LONE_SURROGATES.source}`,
  "gu",
);
// Unicode dashes that NFKC leaves alone; only treated as "-" while looking for a secret.
const DASH_CHARS = /[\u2010-\u2015\u2212\u2043\ufe58\ufe63]/gu;

// Transport encodings decoded for detection only: JSON string escapes (`\"`, `\/`, and the `\u00XX`
// forms of `" / : = @`) and percent-encoding of `: / @ =`.
const ENCODED = /\\(?:u00(?:40|3[aA]|2[fF]|3[dD]|22)|["/])|%(?:3[aA]|2[fF]|40|3[dD])/y;

function decodeEscape(encoded: string): string {
  if (encoded.startsWith("\\u")) return String.fromCharCode(parseInt(encoded.slice(2), 16));
  if (encoded.startsWith("\\")) return encoded.charAt(1);
  return String.fromCharCode(parseInt(encoded.slice(1), 16));
}

const SCHEME_START = /[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\//g;
/** The unit after the '@' must start a host: a letter or digit (any script), '[' (IPv6), a percent-escape, or a `-_.` run into a letter/digit. */
const HOST_START = /(?:[\p{L}\p{N}[]|%[0-9A-Fa-f]|[-_.][\p{L}\p{N}])/yu;
/** A password of up to this many digits is read as a port when a '/', '?' or '#' follows. */
const MAX_PORT_DIGITS = 5;

/**
 * Finds `user:password@` (the '@' included) after each `scheme://`, as [from, to) ranges.
 * A small scanner instead of a regex: no backtracking and monotone cursors, so the total work is
 * O(n) however many `scheme://` occurrences there are and however long a password is. The token
 * ends at whitespace or a quote. Usually the userinfo ends at the last '@' before the first '/',
 * '?' or '#'. If there is none, the password itself holds an unencoded '/', '?' or '#' and the last
 * '@' of the token is used, unless the text after the first ':' up to that delimiter is a port
 * (1-5 digits, up to 65535), as in `host:8080/path/a@b`, or the user part already contains a
 * delimiter (`host?u=a:b@c`, `host/a@b:c@d`). A host (letter or digit of any script, '[', '%xx',
 * or `-_.` before a letter/digit) must follow the '@'.
 * Accepted limitations: see the module comment.
 */
export function userinfoRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Every lookup below is monotone in `start` (which only grows), so each one keeps its last
  // result and only scans text it has not scanned before.
  const nextStop = nextFinder(text, (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0x22 || c === 0x27 || c === 0xa0);
  const nextDelim = nextFinder(text, (c) => c === 0x2f || c === 0x3f || c === 0x23); // '/', '?', '#'
  const nextColon = nextFinder(text, (c) => c === 0x3a);
  const atBeforeDelim = lastAtFinder(text);
  const atBeforeEnd = lastAtFinder(text);
  SCHEME_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCHEME_START.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const end = nextStop(start);
    const delim = Math.min(end, nextDelim(start));
    let at = atBeforeDelim(delim);
    if (at < start) {
      at = delim < end ? atBeforeEnd(end) : -1;
      if (at < start) continue;
      const colon = nextColon(start);
      if (colon >= delim) continue;
      // Bounded slice: at most MAX_PORT_DIGITS + 1 units are looked at.
      const digits = delim - colon - 1;
      if (digits <= MAX_PORT_DIGITS && /^\d*$/.test(text.slice(colon + 1, delim)) && Number(text.slice(colon + 1, delim)) <= 65535) {
        continue; // host:port/path...@...
      }
    } else {
      const colon = nextColon(start);
      if (colon >= at) continue;
    }
    HOST_START.lastIndex = at + 1;
    if (!HOST_START.test(text)) continue; // a host must follow
    ranges.push([start, at + 1]);
    SCHEME_START.lastIndex = at + 1;
  }
  return ranges;
}

/** First index >= `from` whose code unit satisfies `test` (text.length if none); `from` never decreases. */
function nextFinder(text: string, test: (code: number) => boolean): (from: number) => number {
  let found = -1;
  return (from) => {
    if (found >= from) return found;
    let i = from;
    while (i < text.length && !test(text.charCodeAt(i))) i += 1;
    found = i;
    return i;
  };
}

/** Index of the last '@' strictly before `limit` (-1 if none); `limit` never decreases between calls. */
function lastAtFinder(text: string): (limit: number) => number {
  const positions: number[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) positions.push(i);
  let next = 0; // positions[0..next) are < the last limit
  return (limit) => {
    while (next < positions.length && (positions[next] as number) < limit) next += 1;
    return next === 0 ? -1 : (positions[next - 1] as number);
  };
}

/** Replaces every secret found in `text` as it is written. */
export function redactSecrets(text: string): string {
  let out = text;
  const found = userinfoRanges(out);
  if (found.length > 0) {
    const parts: string[] = [];
    let cursor = 0;
    for (const [from, to] of found) {
      parts.push(out.slice(cursor, from), REDACTED);
      cursor = to;
    }
    parts.push(out.slice(cursor));
    out = parts.join("");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

interface Cleaned {
  /** The detection copy: no hiding characters or marks, canonical dashes, decoded escapes. */
  readonly text: string;
  /** For each unit of `text`, the [from, to) span of the source it came from. */
  readonly from: number[];
  readonly to: number[];
}

function cleanForDetection(value: string): Cleaned {
  const pieces: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const push = (mapped: string, a: number, b: number): void => {
    pieces.push(mapped);
    for (let k = 0; k < mapped.length; k += 1) {
      from.push(a);
      to.push(b);
    }
  };
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === 0x5c || code === 0x25) {
      ENCODED.lastIndex = i;
      const e = ENCODED.exec(value);
      if (e !== null) {
        push(decodeEscape(e[0]), i, i + e[0].length);
        i += e[0].length;
        continue;
      }
    }
    if (code >= 0x20 && code < 0x7f) {
      push(value.charAt(i), i, i + 1);
      i += 1;
      continue;
    }
    const cp = value.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    // NFKD then drop marks: a composed letter (a `p` with a combining mark, composed by NFKC)
    // goes back to the plain letter that carried the mark.
    const mapped = ch.normalize("NFKD").replace(HIDING_CHARS, "").replace(DASH_CHARS, "-");
    if (mapped !== "") push(mapped, i, i + ch.length);
    i += ch.length;
  }
  return { text: pieces.join(""), from, to };
}

/**
 * Redacts secrets that were split by invisible characters, controls, combining marks or line
 * breaks, written with look-alike dashes, or JSON/percent-encoded: the text is rejoined (and
 * decoded) only to find the secret, and the whole original span (separators included) is
 * replaced, so every untouched character, marks included, stays as it was. One pass, linear.
 */
export function redactSplitSecrets(value: string): string {
  const { text, from: starts, to: ends } = cleanForDetection(value);
  const ranges: Array<[number, number]> = [];
  // Every userinfo range of the cleaned text is mapped back whole (hidden characters inside the
  // user, before the colon, in the password or before the '@' included), and it also owns the
  // hidden characters right after `://` (`https://<ZWSP>user:pw@`). A scheme split by hidden
  // characters (`ht<ZWSP>tps://`) is found in the cleaned text, so it needs no special case.
  for (const [a, b] of userinfoRanges(text)) {
    const prev = ends[a - 1];
    const last = ends[b - 1];
    if (prev !== undefined && last !== undefined) ranges.push([prev, last]);
  }
  for (const pattern of SECRET_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const a = m.index;
      const b = a + m[0].length;
      if (b <= a) continue;
      const first = starts[a];
      const last = ends[b - 1];
      if (first === undefined || last === undefined) continue;
      // Identical in the original: the ordinary pass after cleaning redacts it.
      if (value.slice(first, last) === text.slice(a, b)) continue;
      ranges.push([first, last]);
    }
  }
  if (ranges.length === 0) return value;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const pieces: string[] = [];
  let cursor = 0;
  for (const [first, last] of ranges) {
    if (first < cursor) continue; // overlaps a span already replaced
    pieces.push(value.slice(cursor, first), REDACTED);
    cursor = last;
  }
  pieces.push(value.slice(cursor));
  return pieces.join("");
}

/**
 * Full redaction and cleaning of already size-capped, NFKC-normalised text: split/encoded secrets
 * first (so invisible characters and line breaks cannot hide them), then the one-line cleanup,
 * then the ordinary pass.
 */
export function redactDetail(normalised: string): string {
  const stripped = redactSplitSecrets(normalised);
  return redactSecrets(
    stripped
      .replace(STRIP_CHARS, "")
      .replace(INVISIBLE_CHARS, " ")
      .replace(CONTROL_CHARS, " ")
      .replace(LONE_SURROGATES, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}
