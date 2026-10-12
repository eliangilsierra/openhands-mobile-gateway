import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitTask, type SubmitTaskDeps } from "../../src/core/session.js";
import {
  AUTH_FAILURE_LIMIT,
  BACKOFF_CAP_MS,
  backoffDelayMs,
  createEventSubscriber,
  type EventSubscriber,
  type HealthSignal,
  type OpenHandsEvent,
} from "../../src/openhands/events-subscriber.js";
import { createOpenHandsRestClient } from "../../src/openhands/rest.js";
import { closeStore, openStore } from "../../src/store/db.js";
import { EventCursorRepository } from "../../src/store/event-cursor.js";
import { SeenEventRepository } from "../../src/store/seen-event.js";
import { runInTransaction } from "../../src/store/transaction.js";
import { createRecordingLogger, createTempDbPath, type RecordingLogger } from "../store/helpers.js";

const CONV = "11111111-2222-3333-4444-555555555555";
const KEY = "test-key-do-not-log-0123456789";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function ev(n: number, extra: Record<string, unknown> = {}): OpenHandsEvent {
  return {
    id: `e${n}`,
    timestamp: `2026-10-11T10:00:0${n}.000Z`,
    kind: "MessageEvent",
    source: "agent",
    ...extra,
  };
}

// ---- minimal RFC 6455 test server (the subscriber under test uses the `ws` client) ------------------------------------------

interface Conn {
  readonly url: string;
  readonly frames: string[];
  send(value: unknown): void;
  close(code: number): void;
  kill(): void;
  readonly closed: Promise<void>;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

interface MockServer {
  readonly baseUrl: string;
  readonly conns: Conn[];
  readonly searches: URLSearchParams[];
  searchItems: OpenHandsEvent[];
  refuseWs: boolean;
  onConnection: (conn: Conn, index: number) => void;
  stop(): Promise<void>;
}

async function startServer(): Promise<MockServer> {
  const sockets = new Set<Socket>();
  const state: MockServer = {
    baseUrl: "",
    conns: [],
    searches: [],
    searchItems: [],
    refuseWs: false,
    onConnection: () => undefined,
    stop: async () => undefined,
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (/\/events\/search$/.test(url.pathname)) {
      state.searches.push(url.searchParams);
      const gte = url.searchParams.get("timestamp__gte");
      const items = state.searchItems.filter((e) => gte === null || e.timestamp >= gte);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items, next_page_id: null }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (state.refuseWs) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const frames: string[] = [];
    let buffer = Buffer.alloc(0);
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    socket.on("close", () => resolveClosed());
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = (buffer[0] ?? 0) & 0x0f;
        let length = (buffer[1] ?? 0) & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        payload.forEach((b, i) => {
          payload[i] = b ^ (mask[i % 4] ?? 0);
        });
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 1) frames.push(payload.toString("utf-8"));
        if (opcode === 8) {
          socket.write(frame(8, payload.subarray(0, 2)));
          socket.end();
        }
      }
    });
    const conn: Conn = {
      url: req.url ?? "",
      frames,
      send: (value) => {
        socket.write(frame(1, Buffer.from(JSON.stringify(value))));
      },
      close: (code) => {
        socket.write(frame(8, Buffer.from([code >> 8, code & 0xff])));
        socket.end();
      },
      kill: () => socket.destroy(),
      closed,
    };
    state.conns.push(conn);
    state.onConnection(conn, state.conns.length - 1);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

// ---- harness --------------------------------------------------------------------------------

let server: MockServer;
let db: DatabaseSync;
let cleanup: () => void;
let logger: RecordingLogger;
let subscribers: EventSubscriber[];
let cursors: EventCursorRepository;
let seen: SeenEventRepository;

beforeEach(async () => {
  server = await startServer();
  const temp = createTempDbPath();
  cleanup = temp.cleanup;
  logger = createRecordingLogger();
  db = openStore({ databasePath: temp.path, logger });
  cursors = new EventCursorRepository(db, logger);
  seen = new SeenEventRepository(db, logger);
  subscribers = [];
});

afterEach(async () => {
  for (const s of subscribers) s.close();
  await server.stop();
  closeStore(db);
  cleanup();
});

function make(
  overrides: Partial<Parameters<typeof createEventSubscriber>[0]> = {},
): { sub: EventSubscriber; signals: HealthSignal[]; authFailed: string[] } {
  const signals: HealthSignal[] = [];
  const authFailed: string[] = [];
  const sub = createEventSubscriber({
    baseUrl: server.baseUrl,
    apiKey: KEY,
    cursors,
    seen,
    transaction: (fn) => runInTransaction(db, logger, fn),
    client: createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: KEY }),
    logger,
    random: () => 0.002,
    eventPollSeconds: 0.02,
    onHealthSignal: (s) => signals.push(s),
    onAuthFailed: (id) => authFailed.push(id),
    ...overrides,
  });
  subscribers.push(sub);
  return { sub, signals, authFailed };
}

const ids = (events: readonly OpenHandsEvent[]): string[] => events.map((e) => e.id);

describe("backoffDelayMs", () => {
  it("is full jitter: uniform in [0, min(60s, 1s * 2^attempt))", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(0);
    expect(backoffDelayMs(0, () => 0.999999)).toBeLessThan(1000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(4000);
    expect(backoffDelayMs(5, () => 0.999999)).toBeLessThan(32_000);
  });

  it("caps at 60 s for any attempt", () => {
    for (const attempt of [6, 7, 20, 1000]) {
      expect(backoffDelayMs(attempt, () => 0.999999)).toBeLessThan(BACKOFF_CAP_MS);
      expect(backoffDelayMs(attempt, () => 0.999999)).toBeGreaterThan(59_000);
    }
  });
});

describe("WebSocket replay, dedupe and ordering", () => {
  it("T-AC-1: resumes after a drop with resend_mode=since, no duplicates, order preserved", async () => {
    server.onConnection = (conn, i) => {
      if (i === 0) {
        [1, 2, 3].forEach((n) => conn.send(ev(n)));
        setTimeout(() => conn.kill(), 30);
      } else {
        // Replay is "at or after" the timestamp, so E3 comes again.
        [3, 4, 5].forEach((n) => conn.send(ev(n)));
      }
    };
    const received: OpenHandsEvent[] = [];
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });

    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2", "e3", "e4", "e5"]));
    expect(server.conns).toHaveLength(2);
    expect(server.conns[0]?.url).toContain("resend_mode=all");
    expect(server.conns[1]?.url).toContain("resend_mode=since");
    expect(decodeURIComponent(server.conns[1]?.url ?? "")).toContain(`after_timestamp=${ev(3).timestamp}`);
    expect(cursors.read(CONV)?.lastEventId).toBe("e5");
  });

  it("sends the credential only as the first text frame, never in the URL or the logs", async () => {
    server.onConnection = (conn) => conn.send(ev(1, { content: "TOP-SECRET-EVENT-BODY" }));
    const received: OpenHandsEvent[] = [];
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const conn = server.conns[0];
    expect(JSON.parse(conn?.frames[0] ?? "null")).toEqual({ type: "auth", session_api_key: KEY });
    expect(conn?.url).not.toContain(KEY);
    expect(conn?.url).not.toContain("session_api_key");
    const logs = JSON.stringify(logger.records);
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain("TOP-SECRET-EVENT-BODY");
  });

  it("delivers the same event.id once even when the server repeats it", async () => {
    server.onConnection = (conn) => {
      conn.send(ev(1));
      conn.send(ev(1));
      conn.send(ev(2));
      conn.send(ev(1));
    };
    const received: OpenHandsEvent[] = [];
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2"]));
    await new Promise((r) => setTimeout(r, 30));
    expect(ids(received)).toEqual(["e1", "e2"]);
  });

  it("dedupes by id, not timestamp: a different id with the same timestamp is delivered", async () => {
    server.onConnection = (conn) => {
      conn.send({ ...ev(1), id: "a" });
      conn.send({ ...ev(1), id: "b" });
    };
    const received: OpenHandsEvent[] = [];
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["a", "b"]));
  });

  it("hands events over one at a time, in arrival order, even with a slow consumer", async () => {
    server.onConnection = (conn) => [1, 2, 3].forEach((n) => conn.send(ev(n)));
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { sub } = make();
    sub.subscribe(CONV, async (e) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, e.id === "e1" ? 25 : 1));
      order.push(e.id);
      active -= 1;
    });
    await vi.waitFor(() => expect(order).toEqual(["e1", "e2", "e3"]));
    expect(maxActive).toBe(1);
  });

  it("ignores frames that are not events", async () => {
    server.onConnection = (conn) => {
      conn.send({ no: "id" });
      conn.send([1, 2]);
      conn.send(ev(1));
    };
    const received: OpenHandsEvent[] = [];
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1"]));
    expect(logger.records.some((r) => r.fields?.event === "event.invalid")).toBe(true);
  });

  it("T-AC-5: a crash before the cursor moves redelivers the event, deduped for the ones already recorded", async () => {
    server.onConnection = (conn, i) => {
      if (i === 0) {
        [1, 2].forEach((n) => conn.send(ev(n)));
      } else {
        [1, 2, 3].forEach((n) => conn.send(ev(n)));
      }
    };
    const first: OpenHandsEvent[] = [];
    let commits = 0;
    const a = make({
      // "Crash" while committing E2: the hand-off happened, the cursor/seen insert did not.
      transaction: (fn) => {
        commits += 1;
        if (commits >= 2) throw new Error("simulated crash");
        return runInTransaction(db, logger, fn);
      },
    });
    a.sub.subscribe(CONV, (e) => {
      first.push(e);
    });
    await vi.waitFor(() => expect(commits).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(logger.records.some((r) => r.fields?.event === "event.handoff_failed")).toBe(true));
    a.sub.close();
    expect(ids(first)).toContain("e2");
    expect(cursors.read(CONV)?.lastEventId).toBe("e1");

    const second: OpenHandsEvent[] = [];
    const b = make();
    b.sub.subscribe(CONV, (e) => {
      second.push(e);
    });
    await vi.waitFor(() => expect(ids(second)).toEqual(["e2", "e3"]));
    expect(server.conns.at(-1)?.url).toContain("resend_mode=since");
  });

  it("replays from the cursor when the downstream hand-off throws, without skipping or reordering", async () => {
    server.onConnection = (conn) => [1, 2, 3].forEach((n) => conn.send(ev(n)));
    const received: string[] = [];
    let failed = false;
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      if (e.id === "e2" && !failed) {
        failed = true;
        throw new Error("downstream down");
      }
      received.push(e.id);
    });
    await vi.waitFor(() => expect(received).toEqual(["e1", "e2", "e3"]));
  });
});

describe("authentication failure", () => {
  it("T-AC-2: stops after two consecutive 4001 closes and logs openhands.auth_failed once", async () => {
    server.onConnection = (conn) => conn.close(4001);
    const { sub, signals, authFailed } = make();
    sub.subscribe(CONV, () => undefined);

    await vi.waitFor(() => expect(authFailed).toEqual([CONV]));
    await new Promise((r) => setTimeout(r, 80));
    expect(server.conns).toHaveLength(AUTH_FAILURE_LIMIT);
    expect(sub.isSubscribed(CONV)).toBe(false);
    expect(signals).toContainEqual({ keyStatus: "rejected", openhandsApi: "unreachable" });
    expect(logger.records.filter((r) => r.fields?.event === "openhands.auth_failed")).toHaveLength(1);
  });

  it("a single 4001 is retried", async () => {
    server.onConnection = (conn, i) => {
      if (i === 0) conn.close(4001);
      else conn.send(ev(1));
    };
    const received: OpenHandsEvent[] = [];
    const { sub, authFailed } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1"]));
    expect(authFailed).toEqual([]);
  });

  it("an accepted connection (a frame arrived) resets the 4001 counter", async () => {
    server.onConnection = (conn, i) => {
      if (i === 1) conn.send(ev(1));
      if (i < 3) setTimeout(() => conn.close(i === 1 ? 1006 : 4001), 15);
      else conn.send(ev(2));
    };
    const received: OpenHandsEvent[] = [];
    const { sub, authFailed } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2"]));
    expect(authFailed).toEqual([]);
  });
});

describe("REST fallback", () => {
  it("T-AC-3: polls events/search in order while the socket cannot be opened, and retries the socket", async () => {
    server.refuseWs = true;
    server.searchItems = [ev(1), ev(2), ev(3)];
    const received: OpenHandsEvent[] = [];
    const { sub, signals } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });

    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2", "e3"]));
    expect(signals).toContainEqual({ openhandsApi: "unreachable" });
    // Later polls resume from the cursor.
    server.searchItems = [ev(1), ev(2), ev(3), ev(4)];
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2", "e3", "e4"]));
    expect(server.searches.some((s) => s.get("timestamp__gte") === ev(3).timestamp)).toBe(true);

    // The socket comes back: it takes over and polling stops.
    server.refuseWs = false;
    server.onConnection = (conn) => conn.send(ev(5));
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2", "e3", "e4", "e5"]));
    await vi.waitFor(() => expect(signals).toContainEqual({ openhandsApi: "reachable" }));
    const polls = server.searches.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(server.searches.length).toBeLessThanOrEqual(polls + 1);
  });

  it("T-AC-3: also falls back when the port refuses connections outright", async () => {
    const port = Number(new URL(server.baseUrl).port);
    server.searchItems = [ev(1), ev(2)];
    const refusedUrl = server.baseUrl.replace(String(port), "1");
    const received: OpenHandsEvent[] = [];
    const { sub } = make({ baseUrl: refusedUrl });
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1", "e2"]));
  });
});

describe("lifecycle", () => {
  it("T-AC-4: closes the socket WS_IDLE_SECONDS after a terminal status and does not reconnect", async () => {
    const { sub } = make({ wsIdleSeconds: 0.05 });
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    sub.setTerminal(CONV, true);
    await server.conns[0]?.closed;
    expect(sub.isSubscribed(CONV)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(server.conns).toHaveLength(1);

    // Active again: a new subscription opens a new socket.
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(server.conns).toHaveLength(2));
  });

  it("a conversation that becomes active again before the timer fires keeps its socket", async () => {
    const { sub } = make({ wsIdleSeconds: 0.05 });
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    sub.setTerminal(CONV, true);
    sub.subscribe(CONV, () => undefined);
    await new Promise((r) => setTimeout(r, 120));
    expect(sub.isSubscribed(CONV)).toBe(true);
    expect(server.conns).toHaveLength(1);
  });

  it("events arriving while terminal postpone the idle close", async () => {
    server.onConnection = (conn) => {
      conn.send(ev(1));
    };
    const { sub } = make({ wsIdleSeconds: 0.1 });
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(cursors.read(CONV)?.lastEventId).toBe("e1"));
    sub.setTerminal(CONV, true);
    await new Promise((r) => setTimeout(r, 60));
    server.conns[0]?.send(ev(2));
    await new Promise((r) => setTimeout(r, 60));
    expect(sub.isSubscribed(CONV)).toBe(true);
    await vi.waitFor(() => expect(sub.isSubscribed(CONV)).toBe(false));
  });

  it("unsubscribe closes the socket cleanly and stops reconnecting", async () => {
    const { sub } = make();
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    sub.unsubscribe(CONV);
    await server.conns[0]?.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(server.conns).toHaveLength(1);
    expect(sub.isSubscribed(CONV)).toBe(false);
  });

  it("close() stops every subscription (shutdown)", async () => {
    const other = "99999999-2222-3333-4444-555555555555";
    const { sub } = make();
    sub.subscribe(CONV, () => undefined);
    sub.subscribe(other, () => undefined);
    await vi.waitFor(() => expect(server.conns).toHaveLength(2));
    sub.close();
    await Promise.all(server.conns.map((c) => c.closed));
    expect(sub.isSubscribed(CONV) || sub.isSubscribed(other)).toBe(false);
  });

  it("subscribe is idempotent per conversation and rejects malformed ids", async () => {
    const { sub } = make();
    sub.subscribe(CONV, () => undefined);
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(server.conns).toHaveLength(1);
    expect(() => sub.subscribe("../x?y=1", () => undefined)).toThrow(TypeError);
  });

  it("keeps reconnecting with backoff while the server drops the socket", async () => {
    server.onConnection = (conn, i) => {
      if (i < 3) conn.kill();
      else conn.send(ev(1));
    };
    const received: OpenHandsEvent[] = [];
    const { sub } = make();
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1"]));
    expect(logger.records.filter((r) => r.fields?.event === "ws.reconnect_scheduled").length).toBeGreaterThanOrEqual(3);
  });
});

describe("backoff reset and poll timer cleanup", () => {
  const delays = (): number[] =>
    logger.records
      .filter((r) => r.fields?.event === "ws.reconnect_scheduled")
      .map((r) => Number(r.fields?.duration_ms));

  it("grows the delay across consecutive failed opens", async () => {
    server.refuseWs = true;
    const { sub } = make({ random: () => 0.0099 });
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(delays().length).toBeGreaterThanOrEqual(3));
    expect(delays().slice(0, 3)).toEqual([9, 19, 39]);
  });

  it("resets the delay to the base after a successful open", async () => {
    server.onConnection = (conn, i) => {
      if (i < 2) setTimeout(() => conn.kill(), 20);
      else conn.send(ev(1));
    };
    const received: OpenHandsEvent[] = [];
    const { sub } = make({ random: () => 0.0099 });
    sub.subscribe(CONV, (e) => {
      received.push(e);
    });
    await vi.waitFor(() => expect(ids(received)).toEqual(["e1"]));
    // Both drops happened after a successful open, so each starts again from attempt 0.
    expect(delays().slice(0, 2)).toEqual([9, 9]);
  });

  // A long poll interval leaves one timer pending: only clearing it keeps the count still.
  it("clears the pending poll timer once the socket opens", async () => {
    server.refuseWs = true;
    server.searchItems = [ev(1)];
    const { sub, signals } = make({ eventPollSeconds: 0.3 });
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(signals).toContainEqual({ openhandsApi: "unreachable" }));
    await vi.waitFor(() => expect(server.searches.length).toBeGreaterThanOrEqual(1));

    server.refuseWs = false;
    await vi.waitFor(() => expect(signals).toContainEqual({ openhandsApi: "reachable" }));
    const settled = server.searches.length;
    await new Promise((r) => setTimeout(r, 450));
    expect(server.searches.length).toBe(settled);
  });

  it("clears the pending poll timer when the subscription is stopped", async () => {
    server.refuseWs = true;
    server.searchItems = [ev(1)];
    const { sub, signals } = make({ eventPollSeconds: 0.3 });
    sub.subscribe(CONV, () => undefined);
    await vi.waitFor(() => expect(signals).toContainEqual({ openhandsApi: "unreachable" }));
    await vi.waitFor(() => expect(server.searches.length).toBeGreaterThanOrEqual(1));
    // Let the first poll finish so that the next one is only a pending timer.
    await new Promise((r) => setTimeout(r, 30));

    sub.unsubscribe(CONV);
    const settled = server.searches.length;
    await new Promise((r) => setTimeout(r, 450));
    expect(server.searches.length).toBe(settled);
  });
});

describe("session wiring", () => {
  function sessionDeps(activate: SubmitTaskDeps["activate"], existing: boolean): SubmitTaskDeps {
    return {
      registry: { resolve: () => Promise.resolve({ status: "found", project: { workingDir: "/w" } } as never) },
      chatState: { getActiveProject: () => "alpha" },
      bindings: {
        findActive: () => (existing ? ({ conversationId: CONV, projectKey: "alpha" } as never) : null),
        create: () => undefined as never,
        markStale: () => undefined,
        touchLastUsed: () => undefined,
      },
      client: {
        createConversation: () => Promise.resolve({ id: CONV }),
        sendEvent: () => Promise.resolve({}),
      },
      logger,
      ...(activate === undefined ? {} : { activate }),
    };
  }
  const target = { channel: "telegram", externalChatId: "1" };

  it("opens the subscription when a task creates or reaches a conversation", async () => {
    const activate = vi.fn();
    expect(await submitTask(sessionDeps(activate, false), target, "hola", () => Promise.resolve())).toEqual({
      status: "created",
    });
    expect(await submitTask(sessionDeps(activate, true), target, "hola", () => Promise.resolve())).toEqual({
      status: "sent",
    });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledWith(CONV);
  });

  it("does not fail the task when the subscription cannot be opened", async () => {
    const activate = vi.fn(() => {
      throw new Error("boom");
    });
    expect(await submitTask(sessionDeps(activate, true), target, "hola", () => Promise.resolve())).toEqual({
      status: "sent",
    });
    expect(logger.records.some((r) => r.fields?.event === "session.activate_failed")).toBe(true);
  });
});
