import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHealthService,
  startHealthServer,
  type ApiKeyStatus,
  type HealthReport,
  type HealthService,
  type TelegramHealthSource,
} from "../src/health.js";
import { createOpenHandsRestClient, type OpenHandsRestClient } from "../src/openhands/rest.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "./mocks/openhands-server.js";

/** Synthetic value generated per run; no literal credential lives in the repository. */
function synthetic(label: string): string {
  return [label, randomUUID()].join("-");
}

const GOOD_KEY = synthetic("good");
const BAD_KEY = synthetic("bad");
const TG_VALUE = synthetic("tg");
const MOCK_CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
const ACCEPTED: ApiKeyStatus = "accepted";

let mock: MockOpenHandsServer;
let db: DatabaseSync;
const servers: Server[] = [];

function makeClient(baseUrl: string, key: string = GOOD_KEY): OpenHandsRestClient {
  return createOpenHandsRestClient({
    baseUrl,
    apiKey: key,
    requestTimeoutMs: 2_000,
    retry: { maxAttempts: 1, sleep: () => Promise.resolve() },
  });
}

function telegram(status: ReturnType<TelegramHealthSource["status"]>): TelegramHealthSource {
  return { status: () => status };
}

async function listen(service: HealthService): Promise<string> {
  const server = await startHealthServer(service, 0, { host: "127.0.0.1" });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function get(base: string, path = "/health"): Promise<{ status: number; text: string }> {
  const response = await fetch(base + path);
  return { status: response.status, text: await response.text() };
}

async function unreachableBaseUrl(): Promise<string> {
  const dead = await startMockOpenHandsServer(GOOD_KEY);
  const url = dead.baseUrl;
  await dead.close();
  return url;
}

function serverInfoCalls(): number {
  return mock.requests.filter((r) => r.path === "/server_info").length;
}

beforeEach(async () => {
  mock = await startMockOpenHandsServer(GOOD_KEY);
  db = new DatabaseSync(":memory:");
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await mock.close();
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  vi.useRealTimers();
});

describe("health service (unit)", () => {
  it("reports sqlite up and down", async () => {
    const options = { client: makeClient(mock.baseUrl), version: "1.2.3" };
    expect((await createHealthService({ ...options, db }).check()).sqlite).toBe("up");

    db.close();
    const report = await createHealthService({ ...options, db }).check();
    expect(report.sqlite).toBe("down");
    expect(report.status).toBe("degraded");
    expect(report.process).toBe("up");
  });

  it("reports openhands reachable with the key accepted", async () => {
    const report = await createHealthService({ db, client: makeClient(mock.baseUrl), version: "1.2.3" }).check();
    expect(report.status).toBe("ok");
    expect(report.openhands_api).toBe("reachable");
    expect(report.details.version).toBe("1.2.3");
    expect(report.details.api_key).toBe(ACCEPTED);
    expect(report.details.active_subscriptions).toBe(0);
  });

  it("reports a rejected key as reachable but degraded (T-AC-2)", async () => {
    const report = await createHealthService({
      db,
      client: makeClient(mock.baseUrl, BAD_KEY),
      version: "1",
    }).check();
    expect(report.openhands_api).toBe("reachable");
    expect(report.details.api_key).toBe("rejected");
    expect(report.status).toBe("degraded");
    expect(serverInfoCalls()).toBe(1);
  });

  it("reports unreachable when the connection is refused (T-AC-3)", async () => {
    const report = await createHealthService({
      db,
      client: makeClient(await unreachableBaseUrl()),
      version: "1",
    }).check();
    expect(report.openhands_api).toBe("unreachable");
    expect(report.details.api_key).toBe("unknown");
    expect(report.status).toBe("degraded");
  });

  it("reports unreachable when /server_info answers 503", async () => {
    mock.addRule({ method: "GET", path: "/server_info", status: 503 });
    const report = await createHealthService({ db, client: makeClient(mock.baseUrl), version: "1" }).check();
    expect(report.openhands_api).toBe("unreachable");
    expect(report.status).toBe("degraded");
  });

  it("bounds a hanging OpenHands by the probe timeout", async () => {
    mock.addRule({ method: "GET", path: "/server_info", hang: true });
    const report = await createHealthService({
      db,
      client: makeClient(mock.baseUrl),
      version: "1",
      probeTimeoutMs: 100,
    }).check();
    expect(report.openhands_api).toBe("unreachable");
  });

  it("keeps the key status unknown when the authenticated probe fails for a non-auth reason", async () => {
    mock.addRule({ method: "GET", path: "/api/conversations/count", status: 500 });
    const report = await createHealthService({ db, client: makeClient(mock.baseUrl), version: "1" }).check();
    expect(report.openhands_api).toBe("reachable");
    expect(report.details.api_key).toBe("unknown");
    expect(report.status).toBe("ok");
  });

  it.each(["connected", "disconnected", "unknown"] as const)("passes telegram %s through", async (value) => {
    const report = await createHealthService({
      db,
      client: makeClient(mock.baseUrl),
      version: "1",
      telegram: telegram(value),
    }).check();
    expect(report.telegram).toBe(value);
  });

  it("defaults telegram to unknown and survives a throwing source", async () => {
    const options = { db, client: makeClient(mock.baseUrl), version: "1" };
    expect((await createHealthService(options).check()).telegram).toBe("unknown");
    const broken: TelegramHealthSource = {
      status: () => {
        throw new Error("boom");
      },
    };
    expect((await createHealthService({ ...options, telegram: broken }).check()).telegram).toBe("unknown");
  });

  it("never degrades on a disconnected Telegram (T-AC-4)", async () => {
    const report = await createHealthService({
      db,
      client: makeClient(mock.baseUrl),
      version: "1",
      telegram: telegram("disconnected"),
    }).check();
    expect(report.status).toBe("ok");
    expect(report.telegram).toBe("disconnected");
  });

  it("caches the OpenHands probe for cacheSeconds and reports its age", async () => {
    let clock = 1_000_000;
    const service = createHealthService({
      db,
      client: makeClient(mock.baseUrl),
      version: "1",
      cacheSeconds: 15,
      now: () => clock,
    });
    await service.check();
    clock += 7_000;
    const cached = await service.check();
    expect(serverInfoCalls()).toBe(1);
    expect(cached.details.last_openhands_check_age_seconds).toBe(7);
    expect(cached.details.uptime_seconds).toBe(7);

    clock += 8_000;
    const fresh = await service.check();
    expect(serverInfoCalls()).toBe(2);
    expect(fresh.details.last_openhands_check_age_seconds).toBe(0);
  });

  it("shares one in-flight probe between concurrent checks", async () => {
    const service = createHealthService({ db, client: makeClient(mock.baseUrl), version: "1" });
    await Promise.all([service.check(), service.check(), service.check()]);
    expect(serverInfoCalls()).toBe(1);
  });

  it("uses the injected subscription counter", async () => {
    const report = await createHealthService({
      db,
      client: makeClient(mock.baseUrl),
      version: "1",
      activeSubscriptions: () => 2,
    }).check();
    expect(report.details.active_subscriptions).toBe(2);
  });
});

describe("GET /health (integration)", () => {
  it("answers 200 with the documented shape when everything is up (T-AC-1)", async () => {
    const base = await listen(
      createHealthService({ db, client: makeClient(mock.baseUrl), version: "1.0.0", telegram: telegram("connected") }),
    );
    const { status, text } = await get(base);
    const body = JSON.parse(text) as HealthReport;
    expect(status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      process: "up",
      sqlite: "up",
      openhands_api: "reachable",
      telegram: "connected",
      details: {
        version: "1.0.0",
        uptime_seconds: expect.any(Number) as number,
        active_subscriptions: 0,
        last_openhands_check_age_seconds: expect.any(Number) as number,
        api_key: ACCEPTED,
      },
    });
  });

  it("answers 503 degraded when OpenHands is unreachable (T-AC-3)", async () => {
    const base = await listen(
      createHealthService({ db, client: makeClient(await unreachableBaseUrl()), version: "1" }),
    );
    const { status, text } = await get(base);
    const body = JSON.parse(text) as HealthReport;
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.openhands_api).toBe("unreachable");
  });

  it("answers 503 with the key rejected but openhands reachable (T-AC-2)", async () => {
    const base = await listen(createHealthService({ db, client: makeClient(mock.baseUrl, BAD_KEY), version: "1" }));
    const { status, text } = await get(base);
    const body = JSON.parse(text) as HealthReport;
    expect(status).toBe(503);
    expect(body.openhands_api).toBe("reachable");
    expect(body.details.api_key).toBe("rejected");
  });

  it("answers 200 with Telegram disconnected (T-AC-4)", async () => {
    const base = await listen(
      createHealthService({ db, client: makeClient(mock.baseUrl), version: "1", telegram: telegram("disconnected") }),
    );
    const { status, text } = await get(base);
    expect(status).toBe(200);
    expect((JSON.parse(text) as HealthReport).telegram).toBe("disconnected");
  });

  it("never leaks secrets, paths, chat or conversation ids (T-AC-5)", async () => {
    // Cover the success, wrong-key and refused-connection paths.
    const services: HealthService[] = [
      createHealthService({ db, client: makeClient(mock.baseUrl), version: "1", telegram: telegram("connected") }),
      createHealthService({ db, client: makeClient(mock.baseUrl, BAD_KEY), version: "1" }),
      createHealthService({ db, client: makeClient(await unreachableBaseUrl()), version: "1" }),
    ];
    for (const service of services) {
      const { text } = await get(await listen(service));
      expect(text).not.toContain(GOOD_KEY);
      expect(text).not.toContain(BAD_KEY);
      expect(text).not.toContain(TG_VALUE);
      expect(text).not.toContain("/projects");
      expect(text).not.toContain(MOCK_CONVERSATION_ID);
      expect(text).not.toContain("chat");
      expect(text).not.toContain("127.0.0.1");
    }
    // Only the documented keys appear.
    const first = services[0] as HealthService;
    const body = JSON.parse((await get(await listen(first))).text) as HealthReport;
    expect(Object.keys(body).sort()).toEqual(["details", "openhands_api", "process", "sqlite", "status", "telegram"]);
    expect(Object.keys(body.details).sort()).toEqual([
      "active_subscriptions",
      "api_key",
      "last_openhands_check_age_seconds",
      "uptime_seconds",
      "version",
    ]);
  });

  it("serves only GET /health", async () => {
    const base = await listen(createHealthService({ db, client: makeClient(mock.baseUrl), version: "1" }));
    expect((await get(base, "/other")).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
    expect((await get(base, "/health?x=1")).status).toBe(200);
  });

  it("answers 503 without detail when the service throws", async () => {
    const broken: HealthService = {
      check: () => Promise.reject(new Error(`leak ${GOOD_KEY}`)),
    };
    const { status, text } = await get(await listen(broken));
    expect(status).toBe(503);
    expect(text).not.toContain(GOOD_KEY);
  });
});
