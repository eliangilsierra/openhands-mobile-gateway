import { WebSocket } from "ws";
import type { ApiKeyStatus, OpenHandsApiStatus } from "../health.js";
import type { Logger } from "../logger.js";
import { AuthError } from "./errors.js";
import type { OpenHandsRestClient } from "./rest.js";
import type { EventPage } from "./types.js";

/**
 * Event subscriber (architecture §7.5, ADR-0006): one WebSocket per active conversation with
 * first-message auth, exponential backoff with full jitter, timestamp replay from the stored
 * cursor, dedupe by `event.id`, single-consumer ordered delivery and a REST polling fallback.
 *
 * Channel-neutral (NFR-8): it hands raw events to `onEvent` and knows nothing about Telegram.
 * The credential is only ever sent as the first text frame; it is never part of a URL or a log
 * line, and event bodies are never logged (only ids and kinds).
 */

export const DEFAULT_EVENT_POLL_SECONDS = 5;
export const DEFAULT_WS_IDLE_SECONDS = 900;
export const DEFAULT_WS_FAIL_THRESHOLD = 3;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
/** SR-1: largest frame accepted from the upstream (the `ws` default is 100 MiB). */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** SR-2: events waiting for the consumer before the socket is dropped and replayed from the cursor. */
export const DEFAULT_MAX_QUEUE = 1000;
/** N1: serialised bytes waiting for the consumer; a few large events must not exhaust memory either. */
export const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
/** N3: how far ahead of the local clock an event timestamp may be before the event is rejected. */
export const DEFAULT_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
/** N4: hand-off attempts after which an event that always fails is parked (skipped) so the stream moves on. */
export const DEFAULT_MAX_HANDOFF_ATTEMPTS = 5;
/** CR-8: how long a new consumer waits for the previous (possibly hung) one before it starts anyway. */
export const DEFAULT_PREVIOUS_CONSUMER_WAIT_MS = 30_000;
/** SR-3: a socket that stays open this long counts as healthy and resets the backoff. */
export const DEFAULT_STABLE_MS = 30_000;
/** CR-3: page size and page limit of one REST fallback poll. */
const POLL_PAGE_LIMIT = 100;
const POLL_MAX_PAGES = 20;
/**
 * CR-6: the REST fallback sends only parameters of the OpenHands agent-server v1.24.0
 * `GET /api/conversations/{id}/events/search` contract (`page_id`, `limit` 1..100, `kind`, `source`,
 * `body`, `sort_order` in {TIMESTAMP, TIMESTAMP_DESC}, `timestamp__gte`, `timestamp__lt`).
 * `TIMESTAMP` is also the server default (oldest first).
 */
const POLL_SORT_ORDER = "TIMESTAMP";
const MAX_KIND_LENGTH = 64;
const MAX_TIMESTAMP_LENGTH = 64;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?$/;
/** Consecutive `4001` closes after which the subscription stops. */
export const AUTH_FAILURE_LIMIT = 2;
const WS_AUTH_FAILED_CODE = 4001;
/** Protocol field name of the first-message auth frame (ADR-0006 point 1). */
const AUTH_KEY_FIELD = "session_api_key";

/** Shape of a serialised OpenHands event (§7.5 envelope); extra fields are kept untouched. */
export interface OpenHandsEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly source?: string;
  readonly parent_id?: string | null;
  readonly [key: string]: unknown;
}

/**
 * Called once per new event, in arrival order; the next one starts after the returned promise settles.
 * The event comes from the upstream and is untrusted: do not merge it into other objects
 * (`Object.assign`, deep merge); the subscriber already drops an own `__proto__` key.
 */
export type EventHandler = (event: OpenHandsEvent) => void | Promise<void>;

/** Signals for the health module (#8): `openhands_api` and `api_key`. */
export interface HealthSignal {
  readonly openhandsApi?: OpenHandsApiStatus;
  readonly keyStatus?: ApiKeyStatus;
}

/** The subset of the `ws` `WebSocket` (ADR-0002) the subscriber uses. */
export interface EventSocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: (event: { readonly code: number }) => void): void;
}

export interface EventCursorStore {
  read(conversationId: string): { readonly lastEventTimestamp: string | null } | null;
  advance(conversationId: string, lastEventId: string, lastEventTimestamp: string): void;
}

export interface SeenEventStore {
  hasSeen(conversationId: string, eventId: string): boolean;
  markSeen(conversationId: string, eventId: string): void;
}

export interface EventSubscriberOptions {
  /** `OPENHANDS_BASE_URL` (http/https); the socket uses the matching ws/wss scheme. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly cursors: EventCursorStore;
  readonly seen: SeenEventStore;
  /** Runs the callback in one SQLite transaction (cursor advance + `seen_event` insert are atomic). */
  readonly transaction: <T>(fn: () => T) => T;
  readonly client: Pick<OpenHandsRestClient, "searchEvents">;
  readonly logger?: Logger;
  readonly eventPollSeconds?: number;
  readonly wsIdleSeconds?: number;
  readonly wsFailThreshold?: number;
  readonly onHealthSignal?: (signal: HealthSignal) => void;
  /** Called once when a subscription is stopped after repeated `4001`s, so the user can be told once. */
  readonly onAuthFailed?: (conversationId: string) => void;
  /** SR-1: maximum accepted frame size in bytes (default 1 MiB). */
  readonly maxFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  /** SR-2: queue high-water mark before the socket is dropped (default 1000). */
  readonly maxQueue?: number;
  /** SR-3: how long a socket must stay open to reset the backoff (default 30 s). */
  readonly stableMs?: number;
  /** N1: serialised size of the queued events before the socket is dropped (default 8 MiB). */
  readonly maxQueueBytes?: number;
  /** N3: tolerated clock skew for event timestamps in the future (default 10 min). */
  readonly maxFutureSkewMs?: number;
  /** N4: hand-off attempts before an event that always fails is parked (default 5). */
  readonly maxHandoffAttempts?: number;
  /** CR-8: wait for a previous consumer of the same conversation before starting anyway (default 30 s). */
  readonly previousConsumerWaitMs?: number;
  /** Clock, injectable for tests (default `Date.now`). */
  readonly now?: () => number;
  readonly createSocket?: (url: string) => EventSocket;
  readonly random?: () => number;
}

export interface EventSubscriber {
  /** Idempotent: an existing subscription keeps running (and its idle timer is cancelled). */
  subscribe(conversationId: string, onEvent: EventHandler): void;
  unsubscribe(conversationId: string): void;
  /** Marks the conversation terminal (starts the idle timer) or active again (cancels it). */
  setTerminal(conversationId: string, terminal: boolean): void;
  isSubscribed(conversationId: string): boolean;
  /** Stops every subscription (shutdown). */
  close(): void;
}

/** Same format the REST client accepts: keeps path and query injection out of the socket URL. */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Full jitter: uniform in [0, min(cap, base * 2^attempt)). `attempt` starts at 0. */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

function parseEvent(value: unknown, latestAllowedMs: number): OpenHandsEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { id, timestamp, kind } = record;
  if (
    typeof id !== "string" ||
    !EVENT_ID_PATTERN.test(id) ||
    typeof timestamp !== "string" ||
    timestamp.length > MAX_TIMESTAMP_LENGTH ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    // N3: a far-future timestamp would pin the replay cursor ahead of every real event.
    Date.parse(timestamp) > latestAllowedMs ||
    typeof kind !== "string" ||
    kind.length > MAX_KIND_LENGTH
  ) {
    return null;
  }
  // SR-6: JSON.parse makes `__proto__` an own data property; remove it so a consumer that merges
  // the event cannot be surprised by it.
  delete record["__proto__"];
  // Safe: the three envelope fields were just checked; everything else is intentionally open.
  return record as OpenHandsEvent;
}

function decodeFrame(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return null;
}

function errType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** SR-4: only http(s)/ws(s), no credentials, query or fragment; the key travels to this host. */
function toSocketBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  const scheme: Record<string, string> = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" };
  const protocol = scheme[url.protocol];
  if (protocol === undefined) {
    throw new TypeError("OpenHands base URL must use http, https, ws or wss");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("OpenHands base URL must not contain credentials, a query or a fragment");
  }
  return `${protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

interface QueuedEvent {
  readonly event: OpenHandsEvent;
  readonly bytes: number;
}

interface Subscription {
  readonly id: string;
  readonly onEvent: EventHandler;
  readonly queue: QueuedEvent[];
  queueBytes: number;
  /** CR-8: ids queued or being handed off; a poll must not queue them again. */
  readonly pending: Set<string>;
  /** N4: failed hand-off attempts per event id. */
  readonly failures: Map<string, number>;
  draining: boolean;
  stopped: boolean;
  terminal: boolean;
  socket: EventSocket | null;
  open: boolean;
  /** An event was handed off on the current socket, or it stayed open long enough (SR-3). */
  healthy: boolean;
  /** Queue overflowed: reconnect once the consumer has caught up (SR-2). */
  resumeAfterDrain: boolean;
  pollGen: number;
  polling: boolean;
  stableTimer: ReturnType<typeof setTimeout> | null;
  openFailures: number;
  reconnectAttempt: number;
  authStrikes: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function createEventSubscriber(options: EventSubscriberOptions): EventSubscriber {
  const { logger } = options;
  const random = options.random ?? Math.random;
  const pollMs = (options.eventPollSeconds ?? DEFAULT_EVENT_POLL_SECONDS) * 1000;
  const idleMs = (options.wsIdleSeconds ?? DEFAULT_WS_IDLE_SECONDS) * 1000;
  const failThreshold = options.wsFailThreshold ?? DEFAULT_WS_FAIL_THRESHOLD;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  const maxHandoffAttempts = options.maxHandoffAttempts ?? DEFAULT_MAX_HANDOFF_ATTEMPTS;
  const previousConsumerWaitMs = options.previousConsumerWaitMs ?? DEFAULT_PREVIOUS_CONSUMER_WAIT_MS;
  const now = options.now ?? Date.now;
  const createSocket =
    options.createSocket ??
    ((url: string): EventSocket =>
      new WebSocket(url, {
        maxPayload: maxFrameBytes,
        handshakeTimeout: handshakeTimeoutMs,
        perMessageDeflate: false,
        followRedirects: false,
      }));
  const socketBase = toSocketBase(options.baseUrl);
  const subscriptions = new Map<string, Subscription>();
  /** Last drain per conversation: a re-subscription waits for it so two consumers never overlap (CR-5). */
  const tails = new Map<string, Promise<void>>();

  function signal(value: HealthSignal): void {
    try {
      options.onHealthSignal?.(value);
    } catch (error) {
      logger?.warn("Health signal hook failed", { event: "ws.health_hook_failed", err_type: errType(error) });
    }
  }

  function parse(value: unknown): OpenHandsEvent | null {
    return parseEvent(value, now() + maxFutureSkewMs);
  }

  function clearQueue(sub: Subscription): void {
    sub.queue.length = 0;
    sub.queueBytes = 0;
    sub.pending.clear();
  }

  /** True when `promise` settled (or there is none); false when `ms` passed first. Never rejects. */
  async function settledOrTimeout(promise: Promise<void> | undefined, ms: number): Promise<boolean> {
    if (promise === undefined) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([promise.then(() => true, () => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function readCursor(sub: Subscription): string | null {
    return options.cursors.read(sub.id)?.lastEventTimestamp ?? null;
  }

  // ---- delivery: single consumer per conversation -------------------------------------------

  /** Returns false when the queue is full and the event was not accepted (SR-2). */
  function enqueue(sub: Subscription, event: OpenHandsEvent): boolean {
    if (sub.stopped) {
      return true;
    }
    // CR-8: a poll re-reads what the consumer has not finished yet (the cursor has not moved).
    if (sub.pending.has(event.id)) {
      return true;
    }
    // N1: the size is the serialised event; one oversized event is still accepted into an empty queue.
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (sub.queue.length >= maxQueue || (sub.queue.length > 0 && sub.queueBytes + bytes > maxQueueBytes)) {
      return false;
    }
    sub.queue.push({ event, bytes });
    sub.queueBytes += bytes;
    sub.pending.add(event.id);
    if (sub.terminal) {
      armIdleTimer(sub);
    }
    void drain(sub);
    return true;
  }

  function drain(sub: Subscription): Promise<void> {
    if (sub.draining) {
      return Promise.resolve();
    }
    sub.draining = true;
    const previous = tails.get(sub.id);
    let run: Promise<void> | undefined;
    run = (async (): Promise<void> => {
      try {
        // Always yields once, so `run` is assigned before the `finally` below can look at it.
        // CR-8: a hung previous consumer must not block this subscription for ever.
        if (!(await settledOrTimeout(previous, previousConsumerWaitMs))) {
          logger?.warn("Previous consumer did not finish; starting anyway", {
            event: "event.previous_consumer_timeout",
            conversation_id: sub.id,
          });
        }
        while (!sub.stopped) {
          const next = sub.queue.shift();
          if (next === undefined) {
            break;
          }
          sub.queueBytes -= next.bytes;
          try {
            await deliver(sub, next.event);
          } finally {
            sub.pending.delete(next.event.id);
          }
        }
      } finally {
        sub.draining = false;
        if (tails.get(sub.id) === run) {
          tails.delete(sub.id);
        }
        if (sub.resumeAfterDrain && !sub.stopped && sub.queue.length === 0) {
          sub.resumeAfterDrain = false;
          scheduleReconnect(sub);
        }
      }
    })();
    tails.set(sub.id, run);
    return run;
  }

  async function deliver(sub: Subscription, event: OpenHandsEvent): Promise<void> {
    try {
      if (options.seen.hasSeen(sub.id, event.id)) {
        logger?.debug("Event already seen", {
          event: "event.deduped",
          conversation_id: sub.id,
          event_id: event.id,
        });
        return;
      }
      await sub.onEvent(event);
      // Only after the hand-off: a crash here re-delivers (at-least-once) instead of losing the event.
      commit(sub, event);
      sub.failures.delete(event.id);
      if (sub.open) {
        markHealthy(sub);
      } else if (sub.resumeAfterDrain) {
        // CR-7: events are still being delivered after an overflow, so the stream is not failing:
        // the reconnect that follows the drain starts from the base delay.
        sub.reconnectAttempt = 0;
      }
      logger?.debug("Event delivered", {
        event: "event.received",
        conversation_id: sub.id,
        event_id: event.id,
        kind: event.kind,
      });
    } catch (error) {
      const attempts = (sub.failures.get(event.id) ?? 0) + 1;
      sub.failures.set(event.id, attempts);
      if (attempts >= maxHandoffAttempts && park(sub, event, attempts)) {
        return;
      }
      // Drop what is queued behind it (order!) and replay from the cursor, which has not moved.
      logger?.error("Event hand-off failed; replaying from cursor", {
        event: "event.handoff_failed",
        conversation_id: sub.id,
        event_id: event.id,
        attempt: attempts,
        err_type: errType(error),
      });
      clearQueue(sub);
      if (!sub.stopped) {
        abandonSocket(sub, 1011);
      }
    }
  }

  /** Marks the event seen and moves the cursor, atomically. */
  function commit(sub: Subscription, event: OpenHandsEvent): void {
    options.transaction(() => {
      options.seen.markSeen(sub.id, event.id);
      // CR-1: the cursor never moves backwards, whatever order the events were handed over in.
      const current = options.cursors.read(sub.id)?.lastEventTimestamp ?? null;
      if (current === null || Date.parse(event.timestamp) >= Date.parse(current)) {
        options.cursors.advance(sub.id, event.id, event.timestamp);
      }
    });
  }

  /**
   * N4: an event whose hand-off failed `maxHandoffAttempts` times is skipped (seen + cursor moved) so
   * it cannot stall the stream. Only ids and kinds are logged, never the payload.
   */
  function park(sub: Subscription, event: OpenHandsEvent, attempts: number): boolean {
    try {
      commit(sub, event);
    } catch (error) {
      logger?.error("Could not park a poison event", {
        event: "event.park_failed",
        conversation_id: sub.id,
        event_id: event.id,
        err_type: errType(error),
      });
      return false;
    }
    sub.failures.delete(event.id);
    logger?.error("Event parked after repeated hand-off failures", {
      event: "event.parked",
      conversation_id: sub.id,
      event_id: event.id,
      kind: event.kind,
      attempt: attempts,
    });
    return true;
  }

  /** A hand-off succeeded on a live socket, or the socket proved stable: backoff starts over (SR-3). */
  function markHealthy(sub: Subscription): void {
    sub.healthy = true;
    sub.openFailures = 0;
    sub.reconnectAttempt = 0;
  }

  /**
   * Detaches the current socket before closing it (CR-1): from here on its listeners ignore every
   * frame, so nothing arrives out of order behind the event that failed, and the reconnect is
   * scheduled here because the detached socket's `close` event is ignored too.
   */
  function abandonSocket(sub: Subscription, code: number, reconnect = true): void {
    const { socket } = sub;
    sub.socket = null;
    sub.open = false;
    sub.healthy = false;
    clearStableTimer(sub);
    if (socket !== null) {
      try {
        socket.close(code);
      } catch {
        // Already closing; nothing left to release.
      }
    }
    if (reconnect) {
      handleClosed(sub, null);
    }
  }

  function clearStableTimer(sub: Subscription): void {
    if (sub.stableTimer !== null) {
      clearTimeout(sub.stableTimer);
      sub.stableTimer = null;
    }
  }

  // ---- WebSocket ------------------------------------------------------------------------------

  function buildUrl(sub: Subscription, cursor: string | null): string {
    const query =
      cursor === null
        ? "resend_mode=all"
        : `resend_mode=since&after_timestamp=${encodeURIComponent(cursor)}`;
    return `${socketBase}/sockets/events/${sub.id}?${query}`;
  }

  function connect(sub: Subscription): void {
    if (sub.stopped) {
      return;
    }
    let cursor: string | null;
    try {
      cursor = readCursor(sub);
    } catch (error) {
      logger?.error("Could not read event cursor", {
        event: "ws.cursor_read_failed",
        conversation_id: sub.id,
        err_type: errType(error),
      });
      scheduleReconnect(sub);
      return;
    }
    logger?.info("Requesting event replay", {
      event: "ws.replay_requested",
      conversation_id: sub.id,
      kind: cursor === null ? "all" : "since",
    });

    let socket: EventSocket;
    try {
      socket = createSocket(buildUrl(sub, cursor));
    } catch (error) {
      logger?.warn("Could not create socket", {
        event: "ws.connect_failed",
        conversation_id: sub.id,
        err_type: errType(error),
      });
      handleClosed(sub, null);
      return;
    }
    sub.socket = socket;
    sub.healthy = false;
    let closed = false;

    socket.addEventListener("open", () => {
      if (sub.stopped || sub.socket !== socket) {
        return;
      }
      sub.open = true;
      // SR-3: opening proves nothing (accept-then-close, poison event); the backoff only resets after
      // a delivered event or a socket that stays open for `stableMs`.
      clearStableTimer(sub);
      sub.stableTimer = setTimeout(() => {
        sub.stableTimer = null;
        if (!sub.stopped && sub.socket === socket) {
          markHealthy(sub);
        }
      }, stableMs);
      stopPolling(sub);
      signal({ openhandsApi: "reachable" });
      logger?.info("Event socket connected", { event: "ws.connected", conversation_id: sub.id });
      try {
        socket.send(JSON.stringify({ type: "auth", [AUTH_KEY_FIELD]: options.apiKey }));
      } catch (error) {
        logger?.warn("Could not send auth frame", {
          event: "ws.auth_send_failed",
          conversation_id: sub.id,
          err_type: errType(error),
        });
      }
    });
    socket.addEventListener("message", (message) => {
      if (sub.stopped || sub.socket !== socket) {
        return;
      }
      // A frame after the auth message proves the key was accepted.
      sub.authStrikes = 0;
      handleFrame(sub, message.data);
    });
    const finish = (code: number | null): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (sub.socket === socket) {
        sub.socket = null;
        sub.open = false;
        clearStableTimer(sub);
        handleClosed(sub, code);
      }
    };
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.addEventListener("error", () => {
      // Once open, a `close` event follows and carries the code. A failed handshake (refused,
      // reset) may only emit `error`, so it has to end the attempt by itself.
      if (!opened) {
        finish(null);
      }
    });
    socket.addEventListener("close", (event) => finish(event.code));
  }

  function handleFrame(sub: Subscription, data: unknown): void {
    const text = decodeFrame(data);
    let parsed: unknown;
    try {
      parsed = text === null ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    const event = parse(parsed);
    if (event === null) {
      logger?.warn("Ignoring a frame that is not an event", { event: "event.invalid", conversation_id: sub.id });
      return;
    }
    if (!enqueue(sub, event)) {
      // SR-2: stop reading; what is queued is still delivered, then we reconnect from the cursor.
      logger?.warn("Event queue full; dropping the socket", { event: "ws.queue_full", conversation_id: sub.id });
      sub.resumeAfterDrain = true;
      abandonSocket(sub, 1013, false);
    }
  }

  function handleClosed(sub: Subscription, code: number | null): void {
    if (sub.stopped) {
      return;
    }
    logger?.warn("Event socket closed", {
      event: "ws.closed",
      conversation_id: sub.id,
      ...(code === null ? {} : { status: code }),
    });
    if (code === WS_AUTH_FAILED_CODE) {
      sub.authStrikes += 1;
      if (sub.authStrikes >= AUTH_FAILURE_LIMIT) {
        stopForAuthFailure(sub);
        return;
      }
    }
    if (!sub.healthy) {
      sub.openFailures += 1;
      if (sub.openFailures >= failThreshold) {
        signal({ openhandsApi: "unreachable" });
        startPolling(sub);
      }
    }
    scheduleReconnect(sub);
  }

  function scheduleReconnect(sub: Subscription): void {
    if (sub.stopped || sub.reconnectTimer !== null) {
      return;
    }
    const delay = backoffDelayMs(sub.reconnectAttempt, random);
    sub.reconnectAttempt += 1;
    logger?.info("Event socket reconnect scheduled", {
      event: "ws.reconnect_scheduled",
      conversation_id: sub.id,
      duration_ms: delay,
    });
    sub.reconnectTimer = setTimeout(() => {
      sub.reconnectTimer = null;
      connect(sub);
    }, delay);
  }

  function stopForAuthFailure(sub: Subscription): void {
    stop(sub);
    signal({ keyStatus: "rejected", openhandsApi: "unreachable" });
    logger?.error("OpenHands rejected the credential on the event socket", {
      event: "openhands.auth_failed",
      conversation_id: sub.id,
    });
    try {
      options.onAuthFailed?.(sub.id);
    } catch (error) {
      logger?.warn("Auth failure hook failed", { event: "ws.auth_hook_failed", err_type: errType(error) });
    }
  }

  // ---- REST fallback --------------------------------------------------------------------------

  function startPolling(sub: Subscription): void {
    // CR-5: `polling` covers the whole loop, including a request in flight (the timer is null then).
    if (sub.polling || sub.stopped) {
      return;
    }
    sub.polling = true;
    const gen = sub.pollGen;
    logger?.warn("Falling back to REST polling", { event: "ws.poll_fallback", conversation_id: sub.id });
    const run = (): void => {
      sub.pollTimer = null;
      void poll(sub).finally(() => {
        if (!sub.stopped && !sub.open && sub.pollGen === gen) {
          sub.pollTimer = setTimeout(run, pollMs);
        }
      });
    };
    run();
  }

  function stopPolling(sub: Subscription): void {
    sub.polling = false;
    sub.pollGen += 1;
    if (sub.pollTimer !== null) {
      clearTimeout(sub.pollTimer);
      sub.pollTimer = null;
    }
  }

  async function poll(sub: Subscription): Promise<void> {
    try {
      const cursor = readCursor(sub);
      const gen = sub.pollGen;
      const collected: OpenHandsEvent[] = [];
      let pageId: string | null = null;
      // CR-3: oldest first, every page up to a bound; the remainder is picked up by the next poll.
      for (let pages = 0; pages < POLL_MAX_PAGES; pages += 1) {
        const page: EventPage = await options.client.searchEvents(sub.id, {
          ...(cursor === null ? {} : { timestamp__gte: cursor }),
          sort_order: POLL_SORT_ORDER,
          limit: POLL_PAGE_LIMIT,
          ...(pageId === null ? {} : { page_id: pageId }),
        });
        if (sub.stopped || sub.pollGen !== gen) {
          return;
        }
        for (const item of page.items ?? []) {
          const event = parse(item);
          if (event === null) {
            logger?.warn("Ignoring an item that is not an event", {
              event: "event.invalid",
              conversation_id: sub.id,
            });
            continue;
          }
          collected.push(event);
        }
        pageId = typeof page.next_page_id === "string" && page.next_page_id !== "" ? page.next_page_id : null;
        if (pageId === null) {
          break;
        }
      }
      // Never rely on the server's order: the cursor follows the first delivered event.
      collected.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      for (const event of collected) {
        if (!enqueue(sub, event)) {
          break;
        }
      }
    } catch (error) {
      logger?.warn("Event poll failed", {
        event: "ws.poll_failed",
        conversation_id: sub.id,
        err_type: errType(error),
      });
      if (error instanceof AuthError && !sub.stopped) {
        sub.authStrikes += 1;
        if (sub.authStrikes >= AUTH_FAILURE_LIMIT) {
          stopForAuthFailure(sub);
        }
      }
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  function armIdleTimer(sub: Subscription): void {
    clearIdleTimer(sub);
    sub.idleTimer = setTimeout(() => {
      sub.idleTimer = null;
      logger?.info("Closing idle event socket", { event: "ws.idle_closed", conversation_id: sub.id });
      stop(sub);
    }, idleMs);
  }

  function clearIdleTimer(sub: Subscription): void {
    if (sub.idleTimer !== null) {
      clearTimeout(sub.idleTimer);
      sub.idleTimer = null;
    }
  }

  function stop(sub: Subscription): void {
    sub.stopped = true;
    clearQueue(sub);
    clearIdleTimer(sub);
    clearStableTimer(sub);
    stopPolling(sub);
    if (sub.reconnectTimer !== null) {
      clearTimeout(sub.reconnectTimer);
      sub.reconnectTimer = null;
    }
    const { socket } = sub;
    sub.socket = null;
    sub.open = false;
    if (subscriptions.get(sub.id) === sub) {
      subscriptions.delete(sub.id);
    }
    try {
      socket?.close(1000);
    } catch {
      // Already closing; nothing left to release.
    }
  }

  return {
    subscribe(conversationId, onEvent) {
      if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
        throw new TypeError("conversation id has an invalid format");
      }
      const existing = subscriptions.get(conversationId);
      if (existing !== undefined) {
        existing.terminal = false;
        clearIdleTimer(existing);
        return;
      }
      const sub: Subscription = {
        id: conversationId,
        onEvent,
        queue: [],
        queueBytes: 0,
        pending: new Set(),
        failures: new Map(),
        draining: false,
        stopped: false,
        terminal: false,
        socket: null,
        open: false,
        healthy: false,
        resumeAfterDrain: false,
        pollGen: 0,
        polling: false,
        stableTimer: null,
        openFailures: 0,
        reconnectAttempt: 0,
        authStrikes: 0,
        reconnectTimer: null,
        pollTimer: null,
        idleTimer: null,
      };
      subscriptions.set(conversationId, sub);
      connect(sub);
    },
    unsubscribe(conversationId) {
      const sub = subscriptions.get(conversationId);
      if (sub !== undefined) {
        stop(sub);
      }
    },
    setTerminal(conversationId, terminal) {
      const sub = subscriptions.get(conversationId);
      if (sub === undefined) {
        return;
      }
      sub.terminal = terminal;
      if (terminal) {
        armIdleTimer(sub);
      } else {
        clearIdleTimer(sub);
      }
    },
    isSubscribed: (conversationId) => subscriptions.has(conversationId),
    close() {
      for (const sub of [...subscriptions.values()]) {
        stop(sub);
      }
    },
  };
}
