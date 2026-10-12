import type { ApiKeyStatus, OpenHandsApiStatus } from "../health.js";
import type { Logger } from "../logger.js";
import { AuthError } from "./errors.js";
import type { OpenHandsRestClient } from "./rest.js";

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

/** Called once per new event, in arrival order; the next one starts after the returned promise settles. */
export type EventHandler = (event: OpenHandsEvent) => void | Promise<void>;

/** Signals for the health module (#8): `openhands_api` and `api_key`. */
export interface HealthSignal {
  readonly openhandsApi?: OpenHandsApiStatus;
  readonly keyStatus?: ApiKeyStatus;
}

/** The subset of the WHATWG `WebSocket` the subscriber uses. */
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

function parseEvent(value: unknown): OpenHandsEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { id, timestamp, kind } = record;
  if (typeof id !== "string" || id === "" || typeof timestamp !== "string" || typeof kind !== "string") {
    return null;
  }
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

function toSocketBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href.replace(/\/+$/, "");
}

interface Subscription {
  readonly id: string;
  readonly onEvent: EventHandler;
  readonly queue: OpenHandsEvent[];
  draining: boolean;
  stopped: boolean;
  terminal: boolean;
  socket: EventSocket | null;
  open: boolean;
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
  const createSocket = options.createSocket ?? ((url: string): EventSocket => new WebSocket(url));
  const socketBase = toSocketBase(options.baseUrl);
  const subscriptions = new Map<string, Subscription>();

  function signal(value: HealthSignal): void {
    try {
      options.onHealthSignal?.(value);
    } catch (error) {
      logger?.warn("Health signal hook failed", { event: "ws.health_hook_failed", err_type: errType(error) });
    }
  }

  function readCursor(sub: Subscription): string | null {
    return options.cursors.read(sub.id)?.lastEventTimestamp ?? null;
  }

  // ---- delivery: single consumer per conversation -------------------------------------------

  function enqueue(sub: Subscription, event: OpenHandsEvent): void {
    if (sub.stopped) {
      return;
    }
    sub.queue.push(event);
    if (sub.terminal) {
      armIdleTimer(sub);
    }
    void drain(sub);
  }

  async function drain(sub: Subscription): Promise<void> {
    if (sub.draining) {
      return;
    }
    sub.draining = true;
    try {
      while (!sub.stopped) {
        const event = sub.queue.shift();
        if (event === undefined) {
          break;
        }
        await deliver(sub, event);
      }
    } finally {
      sub.draining = false;
    }
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
      options.transaction(() => {
        options.seen.markSeen(sub.id, event.id);
        options.cursors.advance(sub.id, event.id, event.timestamp);
      });
      logger?.debug("Event delivered", {
        event: "event.received",
        conversation_id: sub.id,
        event_id: event.id,
        kind: event.kind,
      });
    } catch (error) {
      // Drop what is queued behind it (order!) and replay from the cursor, which has not moved.
      logger?.error("Event hand-off failed; replaying from cursor", {
        event: "event.handoff_failed",
        conversation_id: sub.id,
        event_id: event.id,
        err_type: errType(error),
      });
      sub.queue.length = 0;
      sub.socket?.close();
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
      handleClosed(sub, null, false);
      return;
    }
    sub.socket = socket;
    let opened = false;
    let closed = false;

    socket.addEventListener("open", () => {
      if (sub.stopped || sub.socket !== socket) {
        return;
      }
      opened = true;
      sub.open = true;
      sub.openFailures = 0;
      sub.reconnectAttempt = 0;
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
        handleClosed(sub, code, opened);
      }
    };
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
    const event = parseEvent(parsed);
    if (event === null) {
      logger?.warn("Ignoring a frame that is not an event", { event: "event.invalid", conversation_id: sub.id });
      return;
    }
    enqueue(sub, event);
  }

  function handleClosed(sub: Subscription, code: number | null, opened: boolean): void {
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
    if (!opened) {
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
    if (sub.pollTimer !== null || sub.stopped) {
      return;
    }
    logger?.warn("Falling back to REST polling", { event: "ws.poll_fallback", conversation_id: sub.id });
    const run = (): void => {
      sub.pollTimer = null;
      void poll(sub).finally(() => {
        if (!sub.stopped && !sub.open && sub.pollTimer === null) {
          sub.pollTimer = setTimeout(run, pollMs);
        }
      });
    };
    run();
  }

  function stopPolling(sub: Subscription): void {
    if (sub.pollTimer !== null) {
      clearTimeout(sub.pollTimer);
      sub.pollTimer = null;
    }
  }

  async function poll(sub: Subscription): Promise<void> {
    try {
      const cursor = readCursor(sub);
      const page = await options.client.searchEvents(sub.id, cursor === null ? {} : { timestamp__gte: cursor });
      if (sub.stopped) {
        return;
      }
      for (const item of page.items ?? []) {
        const event = parseEvent(item);
        if (event === null) {
          logger?.warn("Ignoring an item that is not an event", {
            event: "event.invalid",
            conversation_id: sub.id,
          });
          continue;
        }
        enqueue(sub, event);
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
    sub.queue.length = 0;
    clearIdleTimer(sub);
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
        draining: false,
        stopped: false,
        terminal: false,
        socket: null,
        open: false,
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
