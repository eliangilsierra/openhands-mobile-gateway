import { GrammyError, InputFile } from "grammy";
import type { Api } from "grammy";
import type { Notification } from "../../core/translate.js";
import type { Logger } from "../../logger.js";
import { sanitizeErrorMessage } from "./bot.js";

/**
 * Outbound notifier (architecture §6, §7.6, FR-2, FR-3). Delivers channel-neutral
 * `Notification`s to Telegram with one queue per chat, >= 1 s pacing, progress coalescing,
 * chunking and a document fallback.
 *
 * Markup safety (T-B1-6, T-AC-3): NOTHING on this send path sets `parse_mode`. Every message,
 * edit and document caption is plain text, so no agent- or file-name-controlled content can break
 * or forge formatting. Gateway-authored text is plain too: there is deliberately no HTML mode to
 * escape for, hence no way to embed untrusted text in one by mistake.
 *
 * Telegram availability never blocks event processing (NFR-4): `enqueue` is synchronous, never
 * throws for a delivery problem and never awaits the network.
 */

export const MAX_MESSAGE_LENGTH = 4000;
export const DEFAULT_MAX_CHUNKS = 4;
export const MIN_SEND_INTERVAL_MS = 1000;
export const MAX_SEND_ATTEMPTS = 3;
export const MAX_QUEUED_JOBS = 200;
export const MAX_LIVE_LINES = 8;
/** Longest body kept (characters, so <= 4 MB as UTF-8); the rest is cut with a visible marker. */
export const MAX_BODY_CHARS = 1_000_000;
/** Longest `retry_after` honoured on a 429 (seconds); anything larger or invalid is clamped. */
export const MAX_RETRY_AFTER_SECONDS = 3600;
/** An idle chat entry with nothing queued is forgotten after this long. */
export const IDLE_CHAT_TTL_MS = 10 * 60 * 1000;
/** Room kept for the "(i/n) " marker (up to "(99/99) "). */
const MARKER_RESERVE = 8;
const CAPTION = "📎 Salida completa adjunta.";
const TRUNCATION_MARKER = "\n[… salida truncada]";
/** Fixed text (never agent content) sent when part of a multi-message body could not be delivered. */
export const CHUNK_FAILURE_NOTE = "⚠️ No se pudo entregar parte de un mensaje largo; se omitió el resto.";
/** Without this Telegram fetches and renders a preview card for any URL in agent output. */
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

/**
 * How the body is delivered: `log` and `diff` are always documents, whatever their length.
 * Plain text is split above MAX_MESSAGE_LENGTH (4000, architecture §7.6; Telegram's hard limit is 4096).
 */
export type ContentKind = "text" | "log" | "diff";

export interface OutboundNotification {
  /** Telegram chat id. */
  readonly chatId: number | string;
  /** Progress notifications of one conversation coalesce into one live-status message. */
  readonly conversationId: string;
  readonly notification: Notification;
  readonly contentKind?: ContentKind;
}

export type NotifierApi = Pick<Api, "sendMessage" | "editMessageText" | "sendDocument">;

export interface NotifierOptions {
  readonly api: NotifierApi;
  readonly logger?: Logger;
  readonly maxChunks?: number;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

// --- Chunking -------------------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Largest cut index <= limit that does not split a grapheme (so never a surrogate pair or combining sequence). */
function safeCut(text: string, limit: number): number {
  let cut = 0;
  for (const { index, segment } of segmenter.segment(text.slice(0, limit + 32))) {
    const end = index + segment.length;
    if (end > limit) {
      break;
    }
    cut = end;
  }
  if (cut > 0) {
    return cut;
  }
  // A single grapheme longer than the limit: fall back to code points.
  for (const ch of text) {
    if (cut + ch.length > limit) {
      break;
    }
    cut += ch.length;
  }
  return Math.max(cut, 1);
}

/** Splits on paragraph, then line, then hard (grapheme-safe) boundaries; lossless apart from blank pieces. */
export function splitText(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    cut = cut > 0 ? cut + 2 : -1;
    if (cut < 0) {
      const line = window.lastIndexOf("\n");
      cut = line > 0 ? line + 1 : -1;
    }
    if (cut < 0) {
      cut = safeCut(rest, limit);
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces.filter((piece) => piece.trim() !== "");
}

// --- Queue ----------------------------------------------------------------------------------

/** Shared by the chunks of one body; `noted` makes the failure note go out at most once per body. */
interface ChunkGroup {
  noted: boolean;
}

type Job =
  | { readonly kind: "progress"; readonly conversationId: string; lines: string[]; attempts: number }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly terminalFor?: string;
      /** Chunks of one split body share a group: if one is dropped the rest must not be sent. */
      readonly group?: ChunkGroup;
      /** The fixed failure note: never evicted by the queue cap while any other job can go instead. */
      readonly isNote?: true;
      attempts: number;
    }
  | {
      readonly kind: "document";
      readonly content: string;
      readonly filename: string;
      readonly terminalFor?: string;
      attempts: number;
    };

interface LiveStatus {
  readonly conversationId: string;
  readonly messageId: number;
  lines: string[];
}

interface ChatQueue {
  jobs: Job[];
  live: LiveStatus | undefined;
  nextAt: number;
  timer: NodeJS.Timeout | undefined;
  busy: boolean;
}

function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && error.description.includes("message is not modified");
}

/** Bounds memory and wasted API calls: cuts at a grapheme boundary and says so. */
function capBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) {
    return body;
  }
  return `${body.slice(0, safeCut(body, MAX_BODY_CHARS))}${TRUNCATION_MARKER}`;
}

function clipLines(lines: readonly string[]): string[] {
  const kept = lines.slice(-MAX_LIVE_LINES);
  while (kept.length > 1 && kept.join("\n").length > MAX_MESSAGE_LENGTH) {
    kept.shift();
  }
  return kept;
}

export class Notifier {
  private readonly api: NotifierApi;
  private readonly logger: Logger | undefined;
  private readonly maxChunks: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly chats = new Map<string, ChatQueue>();
  private stopped = false;

  constructor(options: NotifierOptions) {
    this.api = options.api;
    this.logger = options.logger;
    this.maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);
    this.minIntervalMs = options.minIntervalMs ?? MIN_SEND_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Queues a notification for delivery. Synchronous; delivery failures are logged, never thrown. */
  enqueue(outbound: OutboundNotification): void {
    if (this.stopped) {
      return;
    }
    const chat = this.chatFor(outbound.chatId);
    const { notification, conversationId } = outbound;
    const kind = outbound.contentKind ?? "text";
    const body = capBody(notification.text.trim());
    if (body === "") {
      return;
    }

    if (kind === "text" && !notification.terminal && body.length <= MAX_MESSAGE_LENGTH / 4) {
      this.enqueueProgress(chat, conversationId, body);
    } else {
      for (const job of this.standaloneJobs(body, kind, notification.terminal ? conversationId : undefined)) {
        this.push(chat, job);
      }
    }
    this.schedule(outbound.chatId, chat);
  }

  /** Cancels timers and drops everything still queued. */
  stop(): void {
    this.stopped = true;
    for (const chat of this.chats.values()) {
      clearTimeout(chat.timer);
      chat.jobs = [];
    }
    this.chats.clear();
  }

  /** Jobs still waiting for a given chat (for tests and diagnostics). */
  pending(chatId: number | string): number {
    return this.chats.get(String(chatId))?.jobs.length ?? 0;
  }

  /** Chats currently tracked (for tests and diagnostics). */
  trackedChats(): number {
    return this.chats.size;
  }

  /** Forgets chats with nothing queued or in flight whose pacing window has passed. */
  private sweepIdle(): void {
    const now = this.now();
    for (const [key, chat] of this.chats) {
      const idle = !chat.busy && chat.timer === undefined && chat.jobs.length === 0 && now >= chat.nextAt;
      if (idle && (chat.live === undefined || now - chat.nextAt >= IDLE_CHAT_TTL_MS)) {
        this.chats.delete(key);
      }
    }
  }

  private chatFor(chatId: number | string): ChatQueue {
    const key = String(chatId);
    let chat = this.chats.get(key);
    if (!chat) {
      this.sweepIdle();
      chat = { jobs: [], live: undefined, nextAt: 0, timer: undefined, busy: false };
      this.chats.set(key, chat);
    }
    return chat;
  }

  private enqueueProgress(chat: ChatQueue, conversationId: string, line: string): void {
    const tail = chat.jobs[chat.jobs.length - 1];
    if (
      tail?.kind === "progress" &&
      tail.conversationId === conversationId &&
      tail.attempts === 0 &&
      !(chat.busy && chat.jobs[0] === tail)
    ) {
      tail.lines = clipLines([...tail.lines, line]);
      return;
    }
    this.push(chat, { kind: "progress", conversationId, lines: [line], attempts: 0 });
  }

  private standaloneJobs(body: string, kind: ContentKind, terminalFor: string | undefined): Job[] {
    const base = terminalFor === undefined ? {} : { terminalFor };
    if (kind === "log" || kind === "diff") {
      return [
        { kind: "document", content: body, filename: kind === "log" ? "output.log" : "changes.diff", attempts: 0, ...base },
      ];
    }
    if (body.length <= MAX_MESSAGE_LENGTH) {
      return [{ kind: "text", text: body, attempts: 0, ...base }];
    }
    const pieceLimit = MAX_MESSAGE_LENGTH - MARKER_RESERVE;
    // Each piece holds at most pieceLimit characters, so more characters than this need more than
    // maxChunks pieces: skip the (linear) split entirely.
    if (body.length > pieceLimit * this.maxChunks) {
      return [{ kind: "document", content: body, filename: "output.txt", attempts: 0, ...base }];
    }
    const pieces = splitText(body, pieceLimit);
    if (pieces.length > this.maxChunks) {
      return [{ kind: "document", content: body, filename: "output.txt", attempts: 0, ...base }];
    }
    const group: ChunkGroup = { noted: false };
    return pieces.map((piece, i) => ({
      kind: "text" as const,
      text: `(${String(i + 1)}/${String(pieces.length)}) ${piece}`,
      group,
      attempts: 0,
      ...base,
    }));
  }

  private push(chat: ChatQueue, job: Job): void {
    let evictedAny = false;
    while (chat.jobs.length >= MAX_QUEUED_JOBS) {
      // jobs[0] is in flight while busy: it must stay (drainOne still handles its outcome).
      const first = chat.busy ? 1 : 0;
      let index = chat.jobs.findIndex((other, i) => i >= first && !(other.kind === "text" && other.isNote === true));
      if (index < 0) {
        index = first; // only failure notes are left: the cap still wins
      }
      const evicted = chat.jobs[index];
      if (evicted === undefined) {
        break;
      }
      evictedAny = true;
      if (evicted.kind === "text" && evicted.group !== undefined && !evicted.group.noted) {
        // No silent gap: the note takes the place of the dropped chunk, the rest of the group goes.
        chat.jobs[index] = this.failureNote(evicted.group);
        this.dropGroupRest(chat, evicted.group, chat.busy ? chat.jobs[0] : undefined);
      } else {
        chat.jobs.splice(index, 1);
      }
    }
    if (evictedAny) {
      this.logger?.warn("notifier queue full, dropped oldest notification", { event: "notify.dropped", status: "queue_full" });
    }
    chat.jobs.push(job);
  }

  private failureNote(group: ChunkGroup): Job {
    group.noted = true;
    return { kind: "text", text: CHUNK_FAILURE_NOTE, isNote: true, attempts: 0 };
  }

  private schedule(chatId: number | string, chat: ChatQueue): void {
    if (this.stopped || chat.busy || chat.timer !== undefined || chat.jobs.length === 0) {
      return;
    }
    const delay = Math.max(0, chat.nextAt - this.now());
    chat.timer = setTimeout(() => {
      chat.timer = undefined;
      void this.drainOne(chatId, chat);
    }, delay);
    chat.timer.unref();
  }

  private async drainOne(chatId: number | string, chat: ChatQueue): Promise<void> {
    const job = chat.jobs[0];
    if (this.stopped || job === undefined) {
      return;
    }
    chat.busy = true;
    chat.nextAt = this.now() + this.minIntervalMs;
    try {
      await this.deliver(chatId, chat, job);
      this.removeJob(chat, job);
    } catch (error) {
      this.onFailure(chat, job, error);
    } finally {
      chat.busy = false;
      this.schedule(chatId, chat);
    }
  }

  private onFailure(chat: ChatQueue, job: Job, error: unknown): void {
    const errType = error instanceof Error ? error.constructor.name : typeof error;
    if (error instanceof GrammyError && error.error_code === 429) {
      // Rate limited: not a failed attempt. Resend no earlier than retry_after.
      const requested: unknown = error.parameters.retry_after;
      const retryAfter =
        typeof requested === "number" && Number.isFinite(requested) && requested > 0
          ? Math.min(requested, MAX_RETRY_AFTER_SECONDS)
          : 1;
      chat.nextAt = Math.max(chat.nextAt, this.now() + retryAfter * 1000);
      this.logger?.warn("telegram rate limited, notification re-queued", { event: "notify.rate_limited", status: "429" });
      return;
    }
    if (error instanceof GrammyError && error.error_code === 403) {
      chat.jobs = [];
      chat.live = undefined;
      this.logger?.warn("telegram chat blocked the bot, queue dropped", { event: "notify.chat_blocked", status: "403" });
      return;
    }
    if (error instanceof GrammyError && error.error_code === 400 && job.kind === "progress") {
      // The live message cannot be edited any more (deleted or too old): start a new one.
      chat.live = undefined;
    }
    job.attempts += 1;
    if (job.attempts >= MAX_SEND_ATTEMPTS) {
      const index = this.removeJob(chat, job);
      if (job.kind === "text" && job.group !== undefined && !job.group.noted) {
        // No silent gap: drop the rest of the long message and tell the chat, in fixed text (once).
        this.dropGroupRest(chat, job.group, undefined);
        chat.jobs.splice(Math.max(index, 0), 0, this.failureNote(job.group));
      }
      this.logger?.error("notification dropped after retries", {
        event: "notify.dropped",
        status: "failed",
        err_type: errType,
        err_msg: sanitizeErrorMessage(error),
      });
      return;
    }
    this.logger?.warn("notification send failed, will retry", {
      event: "notify.retry",
      err_type: errType,
      err_msg: sanitizeErrorMessage(error),
    });
  }

  private removeJob(chat: ChatQueue, job: Job): number {
    const index = chat.jobs.indexOf(job);
    if (index >= 0) {
      chat.jobs.splice(index, 1);
    }
    return index;
  }

  /** Removes the still-queued chunks of a group, except `keep` (the job being sent). */
  private dropGroupRest(chat: ChatQueue, group: ChunkGroup, keep: Job | undefined): void {
    chat.jobs = chat.jobs.filter((other) => other === keep || !(other.kind === "text" && other.group === group));
  }

  private async deliver(chatId: number | string, chat: ChatQueue, job: Job): Promise<void> {
    if (job.kind === "progress") {
      await this.deliverProgress(chatId, chat, job);
      return;
    }
    if (job.kind === "text") {
      await this.api.sendMessage(chatId, job.text, NO_PREVIEW);
    } else {
      await this.api.sendDocument(chatId, new InputFile(Buffer.from(job.content, "utf8"), job.filename), {
        caption: CAPTION,
      });
    }
    // A terminal message ends the live status of its conversation: later progress starts a new one.
    if (job.terminalFor !== undefined && chat.live?.conversationId === job.terminalFor) {
      chat.live = undefined;
    }
  }

  private async deliverProgress(
    chatId: number | string,
    chat: ChatQueue,
    job: Extract<Job, { kind: "progress" }>,
  ): Promise<void> {
    const live = chat.live?.conversationId === job.conversationId ? chat.live : undefined;
    const lines = clipLines([...(live?.lines ?? []), ...job.lines]);
    const text = lines.join("\n");
    if (live) {
      try {
        await this.api.editMessageText(chatId, live.messageId, text, NO_PREVIEW);
      } catch (error) {
        if (!isNotModified(error)) {
          throw error;
        }
      }
      live.lines = lines;
      return;
    }
    const sent = await this.api.sendMessage(chatId, text, NO_PREVIEW);
    chat.live = { conversationId: job.conversationId, messageId: sent.message_id, lines };
  }
}
