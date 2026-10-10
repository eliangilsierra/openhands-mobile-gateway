import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  ConflictError,
  NotFoundError,
  UnavailableError,
  UnexpectedResponseError,
} from "../../src/openhands/errors.js";
import { createOpenHandsRestClient, type OpenHandsRestClient } from "../../src/openhands/rest.js";
import { createLogger } from "../../src/logger.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../mocks/openhands-server.js";

const KEY = "test-key-0123456789-not-a-real-secret";
const CID = "c0ffee00-0000-4000-8000-000000000001";

let server: MockOpenHandsServer;
const sleep = vi.fn((_ms: number) => Promise.resolve());

function makeClient(
  overrides: { requestTimeoutMs?: number; key?: string; lines?: string[]; maxResponseBytes?: number } = {},
): OpenHandsRestClient {
  const lines = overrides.lines;
  const logger = lines
    ? createLogger({ level: "debug", secrets: [], write: (line) => lines.push(line) })
    : undefined;
  return createOpenHandsRestClient({
    baseUrl: server.baseUrl,
    apiKey: overrides.key ?? KEY,
    ...(overrides.requestTimeoutMs !== undefined ? { requestTimeoutMs: overrides.requestTimeoutMs } : {}),
    ...(overrides.maxResponseBytes !== undefined ? { maxResponseBytes: overrides.maxResponseBytes } : {}),
    retry: { maxAttempts: 3, baseDelayMs: 100, sleep, random: () => 0 },
    ...(logger ? { logger } : {}),
  });
}

/** Every one of the 14 calls, keyed by name, with the request the mock should see. */
const CALLS: ReadonlyArray<{
  name: string;
  method: "GET" | "POST";
  path: string;
  run: (c: OpenHandsRestClient) => Promise<unknown>;
  conversationScoped: boolean;
  isRun?: boolean;
}> = [
  { name: "getServerInfo", method: "GET", path: "/server_info", run: (c) => c.getServerInfo(), conversationScoped: false },
  { name: "getOpenApi", method: "GET", path: "/openapi.json", run: (c) => c.getOpenApi(), conversationScoped: false },
  {
    name: "createConversation",
    method: "POST",
    path: "/api/conversations",
    run: (c) => c.createConversation({ workspace: { working_dir: "/projects/alpha" }, initial_message: "hi" }),
    conversationScoped: false,
  },
  { name: "getConversation", method: "GET", path: `/api/conversations/${CID}`, run: (c) => c.getConversation(CID), conversationScoped: true },
  { name: "countConversations", method: "GET", path: "/api/conversations/count", run: (c) => c.countConversations(), conversationScoped: false },
  {
    name: "sendEvent",
    method: "POST",
    path: `/api/conversations/${CID}/events`,
    run: (c) => c.sendEvent(CID, { role: "user", content: "do it", run: true }),
    conversationScoped: true,
  },
  { name: "runConversation", method: "POST", path: `/api/conversations/${CID}/run`, run: (c) => c.runConversation(CID), conversationScoped: true, isRun: true },
  { name: "pauseConversation", method: "POST", path: `/api/conversations/${CID}/pause`, run: (c) => c.pauseConversation(CID), conversationScoped: true },
  { name: "interruptConversation", method: "POST", path: `/api/conversations/${CID}/interrupt`, run: (c) => c.interruptConversation(CID), conversationScoped: true },
  {
    name: "setConfirmationPolicy",
    method: "POST",
    path: `/api/conversations/${CID}/confirmation_policy`,
    run: (c) => c.setConfirmationPolicy(CID, { kind: "AlwaysConfirm" }),
    conversationScoped: true,
  },
  {
    name: "respondToConfirmation",
    method: "POST",
    path: `/api/conversations/${CID}/events/respond_to_confirmation`,
    run: (c) => c.respondToConfirmation(CID, { accept: true, reason: "telegram user decision" }),
    conversationScoped: true,
  },
  {
    name: "searchEvents",
    method: "GET",
    path: `/api/conversations/${CID}/events/search`,
    run: (c) => c.searchEvents(CID, { timestamp__gte: "2026-01-01T00:00:00", limit: 50 }),
    conversationScoped: true,
  },
  { name: "searchSubdirs", method: "GET", path: "/api/file/search_subdirs", run: (c) => c.searchSubdirs("/projects"), conversationScoped: false },
  { name: "listWorkspaces", method: "GET", path: "/api/workspaces", run: (c) => c.listWorkspaces(), conversationScoped: false },
];

beforeAll(async () => {
  server = await startMockOpenHandsServer(KEY);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.requests.length = 0;
  server.clearRules();
  sleep.mockClear();
});

describe("construction", () => {
  it("refuses an empty API key", () => {
    expect(() => createOpenHandsRestClient({ baseUrl: "http://x", apiKey: "  " })).toThrow(TypeError);
  });

  it("rejects an empty conversation id before any request", async () => {
    await expect(makeClient().getConversation("")).rejects.toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });
});

describe("success shapes and T-AC-1 (header on every call)", () => {
  it.each(CALLS)("$name hits $method $path with X-Session-API-Key", async (call) => {
    const result = await call.run(makeClient());
    expect(result).toBeDefined();
    expect(server.requests).toHaveLength(1);
    const seen = server.requests[0];
    expect(seen?.method).toBe(call.method);
    expect(seen?.path).toBe(call.path);
    expect(seen?.headers["x-session-api-key"]).toBe(KEY);
  });

  it("sends the documented bodies and query parameters", async () => {
    const client = makeClient();
    await client.createConversation({ workspace: { working_dir: "/projects/alpha" }, initial_message: "hi" });
    await client.sendEvent(CID, { role: "user", content: "task", run: true });
    await client.respondToConfirmation(CID, { accept: false, reason: "no" });
    await client.searchEvents(CID, { timestamp__gte: "2026-01-01T00:00:00", limit: 5 });
    await client.searchSubdirs("/projects");

    expect(server.requests[0]?.body).toEqual({ workspace: { working_dir: "/projects/alpha" }, initial_message: "hi" });
    expect(server.requests[1]?.body).toEqual({ role: "user", content: "task", run: true });
    expect(server.requests[2]?.body).toEqual({ accept: false, reason: "no" });
    expect(server.requests[3]?.query.get("limit")).toBe("5");
    expect(server.requests[3]?.query.get("timestamp__gte")).toBe("2026-01-01T00:00:00");
    expect(server.requests[4]?.query.get("path")).toBe("/projects");
  });

  it("returns the parsed bodies", async () => {
    const client = makeClient();
    expect((await client.getServerInfo()).version).toBe("1.49.6");
    expect((await client.createConversation({ workspace: { working_dir: "/p" } })).id).toBeTruthy();
    expect(await client.countConversations()).toBe(3);
    expect((await client.getConversation(CID)).execution_status).toBe("running");
  });

  it("keeps the header on every retry", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 502, times: 2 });
    await makeClient().listWorkspaces();
    expect(server.requests).toHaveLength(3);
    for (const seen of server.requests) {
      expect(seen.headers["x-session-api-key"]).toBe(KEY);
    }
  });
});

describe("T-AC-2: 401 -> AuthError without the key", () => {
  it.each(CALLS)("$name", async (call) => {
    server.addRule({ method: call.method, path: call.path, status: 401, body: { detail: `bad ${KEY}` } });
    const lines: string[] = [];
    const error = await call.run(makeClient({ lines })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    const text = JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack, lines });
    expect(text).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("does not retry a 401", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 401 });
    await expect(makeClient().listWorkspaces()).rejects.toBeInstanceOf(AuthError);
    expect(server.requests).toHaveLength(1);
  });

  it("maps a real wrong-key rejection from the server", async () => {
    await expect(makeClient({ key: "wrong-key" }).countConversations()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("T-AC-3 and other status mapping", () => {
  it.each(CALLS.filter((c) => c.conversationScoped))("404 on $name -> NotFoundError", async (call) => {
    server.addRule({ method: call.method, path: call.path, status: 404 });
    await expect(call.run(makeClient())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404 on a non-conversation call is not a NotFoundError", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 404 });
    await expect(makeClient().listWorkspaces()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("409 on /run -> ConflictError", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/run`, status: 409 });
    await expect(makeClient().runConversation(CID)).rejects.toBeInstanceOf(ConflictError);
  });

  it("409 elsewhere is not a ConflictError", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/pause`, status: 409 });
    await expect(makeClient().pauseConversation(CID)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.each([502, 503, 504])("%i on a POST -> UnavailableError", async (status) => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/pause`, status });
    const error = await makeClient().pauseConversation(CID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnavailableError);
    expect((error as UnavailableError).status).toBe(status);
  });

  it("maps a 500 to UnexpectedResponseError", async () => {
    server.addRule({ method: "GET", path: "/server_info", status: 500 });
    await expect(makeClient().getServerInfo()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("does not leak the response body into the error", async () => {
    server.addRule({ method: "GET", path: "/server_info", status: 500, body: { detail: "secret-detail-xyz" } });
    const error = await makeClient().getServerInfo().catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("secret-detail-xyz");
  });
});

describe("T-AC-4: retries", () => {
  it("retries a GET on 502 with exponential backoff and then succeeds", async () => {
    server.addRule({ method: "GET", path: `/api/conversations/${CID}`, status: 502, times: 2 });
    const result = await makeClient().getConversation(CID);
    expect(result.id).toBe(CID);
    expect(server.requests).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("gives up after maxAttempts with UnavailableError", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 503 });
    await expect(makeClient().listWorkspaces()).rejects.toBeInstanceOf(UnavailableError);
    expect(server.requests).toHaveLength(3);
  });

  it("never retries POST .../events on 502", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/events`, status: 502 });
    await expect(makeClient().sendEvent(CID, { role: "user", content: "x", run: true })).rejects.toBeInstanceOf(
      UnavailableError,
    );
    expect(server.requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never retries any POST", async () => {
    server.addRule({ method: "POST", path: "/api/conversations", status: 503 });
    await expect(makeClient().createConversation({ workspace: { working_dir: "/p" } })).rejects.toBeInstanceOf(
      UnavailableError,
    );
    expect(server.requests).toHaveLength(1);
  });

  it("does not retry a 404", async () => {
    server.addRule({ method: "GET", path: `/api/conversations/${CID}`, status: 404 });
    await expect(makeClient().getConversation(CID)).rejects.toBeInstanceOf(NotFoundError);
    expect(server.requests).toHaveLength(1);
  });
});

describe("timeouts and transport failures", () => {
  it("times out a hung POST with UnavailableError and no retry", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/events`, hang: true });
    const error = await makeClient({ requestTimeoutMs: 150 })
      .sendEvent(CID, { role: "user", content: "x", run: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnavailableError);
    expect((error as UnavailableError).status).toBeUndefined();
    expect(server.requests).toHaveLength(1);
  });

  it("times out a hung GET and retries it", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", hang: true, times: 1 });
    const result = await makeClient({ requestTimeoutMs: 150 }).listWorkspaces();
    expect(result).toBeDefined();
    expect(server.requests).toHaveLength(2);
  });

  it("maps a refused connection to UnavailableError", async () => {
    const client = createOpenHandsRestClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: KEY,
      retry: { maxAttempts: 2, baseDelayMs: 1, sleep },
    });
    await expect(client.getServerInfo()).rejects.toBeInstanceOf(UnavailableError);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("CR-1: malformed 2xx JSON", () => {
  it("POST .../events -> UnexpectedResponseError, not retried, not Unavailable", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/events`, status: 200, raw: "{not json" });
    const error = await makeClient()
      .sendEvent(CID, { role: "user", content: "x", run: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error).not.toBeInstanceOf(UnavailableError);
    expect((error as UnexpectedResponseError).status).toBe(200);
    expect(server.requests).toHaveLength(1);
  });

  it("GET -> UnexpectedResponseError and is not retried", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 200, raw: "<html>oops" });
    await expect(makeClient().listWorkspaces()).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(server.requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("SR-1: conversation id allow-list", () => {
  it.each([".", "..", "../x", "a/b", "a%2Fb", "a b", "a?b=1", "a#b", "-lead", "x".repeat(65), "id\n", ""])(
    "rejects %j before any request",
    async (id) => {
      const client = makeClient();
      await expect(client.getConversation(id)).rejects.toThrow(TypeError);
      await expect(client.runConversation(id)).rejects.toThrow(TypeError);
      await expect(client.searchEvents(id)).rejects.toThrow(TypeError);
      expect(server.requests).toHaveLength(0);
    },
  );

  it("accepts a UUID and a hex id", async () => {
    const client = makeClient();
    await client.getConversation("c0ffee00-0000-4000-8000-000000000001");
    await client.getConversation("deadbeef");
    expect(server.requests).toHaveLength(2);
  });
});

describe("SR-2: redirects are never followed", () => {
  it.each([301, 302, 307, 308])("%i -> UnexpectedResponseError and the key never reaches the target", async (status) => {
    const target = await startMockOpenHandsServer("irrelevant");
    try {
      server.addRule({
        method: "GET",
        path: `/api/conversations/${CID}`,
        status,
        headers: { location: `${target.baseUrl}/api/conversations/${CID}` },
      });
      await expect(makeClient().getConversation(CID)).rejects.toBeInstanceOf(UnexpectedResponseError);
      expect(target.requests).toHaveLength(0);
      expect(server.requests).toHaveLength(1);
    } finally {
      await target.close();
    }
  });

  it("does not follow a redirect on a POST either", async () => {
    const target = await startMockOpenHandsServer("irrelevant");
    try {
      server.addRule({
        method: "POST",
        path: `/api/conversations/${CID}/events`,
        status: 307,
        headers: { location: `${target.baseUrl}/steal` },
      });
      await expect(makeClient().sendEvent(CID, { role: "user", content: "x", run: true })).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
      expect(target.requests).toHaveLength(0);
    } finally {
      await target.close();
    }
  });
});

describe("SR-3: base URL scheme", () => {
  it.each(["file:///etc/passwd", "ftp://host/", "javascript:alert(1)", "not a url", "  "])(
    "refuses %j",
    (baseUrl) => {
      expect(() => createOpenHandsRestClient({ baseUrl, apiKey: KEY })).toThrow(TypeError);
    },
  );

  it.each(["http://u:p@h", "http://h/?a=1", "http://h/#f", "http://u@h/", "http://h/?", "http://h/#", "http://h/x?"])(
    "refuses credentials, query or fragment: %s",
    (baseUrl) => {
      expect(() => createOpenHandsRestClient({ baseUrl, apiKey: KEY })).toThrow(TypeError);
    },
  );

  it("accepts a trailing slash and a path prefix", () => {
    expect(() => createOpenHandsRestClient({ baseUrl: "http://host:8000/", apiKey: KEY })).not.toThrow();
    expect(() => createOpenHandsRestClient({ baseUrl: "http://host:8000/prefix", apiKey: KEY })).not.toThrow();
  });

  it("accepts http and https", () => {
    expect(() => createOpenHandsRestClient({ baseUrl: "http://agentcanvas:8000/", apiKey: KEY })).not.toThrow();
    expect(() => createOpenHandsRestClient({ baseUrl: "https://agentcanvas.example", apiKey: KEY })).not.toThrow();
  });
});

describe("CR-3, CR-4, SR-4: outcome flag, retry log, jitter", () => {
  it("flags a timed-out POST, and a 502 or 504 POST, as outcomeUnknown; a 503 POST and a 502 GET are not", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/events`, hang: true, times: 1 });
    const post = await makeClient({ requestTimeoutMs: 100 })
      .sendEvent(CID, { role: "user", content: "x", run: true })
      .catch((e: unknown) => e);
    expect((post as UnavailableError).outcomeUnknown).toBe(true);

    for (const [status, expected] of [[502, true], [504, true], [503, false]] as const) {
      server.clearRules();
      server.addRule({ method: "POST", path: `/api/conversations/${CID}/pause`, status });
      const bad = await makeClient().pauseConversation(CID).catch((e: unknown) => e);
      expect(bad).toBeInstanceOf(UnavailableError);
      expect((bad as UnavailableError).outcomeUnknown).toBe(expected);
    }
    server.clearRules();
    server.addRule({ method: "GET", path: "/api/workspaces", status: 502 });
    const get = await makeClient().listWorkspaces().catch((e: unknown) => e);
    expect((get as UnavailableError).outcomeUnknown).toBe(false);
  });

  it("logs the retry without a bogus status when there was no response", async () => {
    const lines: string[] = [];
    server.addRule({ method: "GET", path: "/api/workspaces", hang: true, times: 1 });
    await makeClient({ requestTimeoutMs: 100, lines }).listWorkspaces();
    const retry = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.event === "openhands.retry");
    expect(retry).toBeDefined();
    expect(retry).not.toHaveProperty("status");
  });

  it("adds up to 20% jitter to the backoff", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 502, times: 2 });
    const client = createOpenHandsRestClient({
      baseUrl: server.baseUrl,
      apiKey: KEY,
      retry: { maxAttempts: 3, baseDelayMs: 100, sleep, random: () => 0.5 },
    });
    await client.listWorkspaces();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([110, 220]);
  });
});

describe("CR-7, LOW-1: body handling", () => {
  it.each([
    ["stalls", { stallBody: true }],
    ["aborts", { abortBody: true }],
  ] as const)("a 401 whose body %s still maps to AuthError", async (_label, rule) => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 401, ...rule });
    await expect(makeClient({ requestTimeoutMs: 500 }).listWorkspaces()).rejects.toBeInstanceOf(AuthError);
  });

  it.each([
    ["stalls", { stallBody: true }],
    ["aborts", { abortBody: true }],
  ] as const)("a 404 whose body %s still maps to NotFoundError", async (_label, rule) => {
    server.addRule({ method: "GET", path: `/api/conversations/${CID}`, status: 404, ...rule });
    await expect(makeClient({ requestTimeoutMs: 500 }).getConversation(CID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a 2xx body over the cap without retrying", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 200, bodyBytes: 4096 });
    const error = await makeClient({ maxResponseBytes: 1024 }).listWorkspaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).status).toBe(200);
    expect(server.requests.filter((r) => r.path === "/api/workspaces")).toHaveLength(1);
  });

  it("parses a 2xx body under the cap", async () => {
    server.addRule({ method: "GET", path: "/api/workspaces", status: 200, bodyBytes: 100 });
    await expect(makeClient({ maxResponseBytes: 1024 }).listWorkspaces()).resolves.toEqual({
      pad: "x".repeat(100),
    });
  });

  it("a stalled 2xx body is an outage, with outcomeUnknown on a POST", async () => {
    server.addRule({ method: "POST", path: `/api/conversations/${CID}/pause`, status: 200, stallBody: true });
    const error = await makeClient({ requestTimeoutMs: 200 }).pauseConversation(CID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnavailableError);
    expect((error as UnavailableError).outcomeUnknown).toBe(true);
  });
});

describe("T-AC-5: all HTTP access lives in src/openhands/rest.ts", () => {
  function listSources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return listSources(full);
      }
      return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
    });
  }

  const srcRoot = join(process.cwd(), "src");
  const restFile = join(srcRoot, "openhands", "rest.ts");
  const others = listSources(srcRoot).filter((file) => file !== restFile);

  it("finds the other source files", () => {
    expect(others.length).toBeGreaterThan(0);
  });

  it.each([
    ["the OpenHands client package", /@openhands\/typescript-client/, []],
    ["fetch()", /\bfetch\s*\(/, []],
    // src/health.ts only *listens* (GET /health); it makes no outbound call, so it may import it.
    ["node:http(s)", /from\s+["'](?:node:)?https?["']/, ["src/health.ts"]],
    ["the session key header", /X-Session-API-Key/i, []],
    ["undici/axios/got", /from\s+["'](?:undici|axios|got|node-fetch)["']/, []],
  ] as const)("no other module uses %s", (_label, pattern, exempt) => {
    const offenders = others
      .filter((file) => pattern.test(readFileSync(file, "utf-8")))
      .map((file) => relative(process.cwd(), file).split(sep).join("/"))
      .filter((file) => !(exempt as readonly string[]).includes(file));
    expect(offenders).toEqual([]);
  });

  it("rest.ts never imports the LLM subpaths or the package root (T-B4-2)", () => {
    const text = readFileSync(restFile, "utf-8");
    expect(text).not.toMatch(/from\s+["']@openhands\/typescript-client/);
    expect(text).not.toMatch(/typescript-client\/llm/);
  });

  it("rest.ts reaches none of the deliberately-not-called routes", () => {
    const text = readFileSync(restFile, "utf-8").split("\n").filter((l) => !l.trimStart().startsWith("*")).join("\n");
    for (const forbidden of ["/api/automation", "/api/settings", "/api/secrets", "/api/bash", "/api/tool", "/api/skills", "/api/vscode", "/api/git", "/api/file/upload", "/api/file/download", "/fork", "/navigate", "delete("]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
