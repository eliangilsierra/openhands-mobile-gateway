import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal in-process mock of the OpenHands agent-server (architecture §21, calls 1-14).
 * Reusable by later tasks' tests. It records every request and lets a test force an error
 * status or a hang for a given route.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
}

export interface MockRule {
  readonly method: string;
  /** Matched against the path with `String.prototype.includes`/equality (see `matches`). */
  readonly path: string | RegExp;
  /** HTTP status to answer with. Ignored when `hang` is true. */
  readonly status?: number;
  /** Never answer (used to exercise timeouts). */
  readonly hang?: boolean;
  /** How many times the rule applies; default: forever. */
  times?: number;
  /** Optional body for the forced response. */
  readonly body?: unknown;
  /** Sent verbatim instead of `body` (e.g. malformed JSON). */
  readonly raw?: string;
  /** Answer with a JSON body padded to roughly this many bytes. */
  readonly bodyBytes?: number;
  /** Send the headers and a first chunk, then never finish the body. */
  readonly stallBody?: boolean;
  /** Send the headers and a first chunk, then destroy the connection. */
  readonly abortBody?: boolean;
  /** Extra response headers (e.g. `location` for a redirect). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MockOpenHandsServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** The API key the server accepts; any other value (or none) gets 401 on `/api/*`. */
  readonly expectedKey: string;
  addRule(rule: MockRule): void;
  clearRules(): void;
  close(): Promise<void>;
}

const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

function matches(rule: MockRule, method: string, path: string): boolean {
  if (rule.method !== method) {
    return false;
  }
  return typeof rule.path === "string" ? rule.path === path : rule.path.test(path);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function route(method: string, path: string, body: unknown): { status: number; body: unknown } {
  const conv = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (method === "GET" && path === "/server_info") {
    return { status: 200, body: { version: "1.49.6", sdk_version: "1.49.6" } };
  }
  if (method === "GET" && path === "/openapi.json") {
    return { status: 200, body: { openapi: "3.1.0", paths: { "/api/conversations": {} } } };
  }
  if (method === "POST" && path === "/api/conversations") {
    return { status: 201, body: { id: CONVERSATION_ID, execution_status: "idle", request: body } };
  }
  if (method === "GET" && path === "/api/conversations/count") {
    return { status: 200, body: 3 };
  }
  if (method === "GET" && path === "/api/file/search_subdirs") {
    return { status: 200, body: { items: ["/projects/alpha", "/projects/beta"] } };
  }
  if (method === "GET" && path === "/api/workspaces") {
    return { status: 200, body: { items: [{ path: "/projects/alpha" }] } };
  }
  if (conv) {
    const suffix = conv[2] ?? "";
    if (method === "GET" && suffix === "") {
      return { status: 200, body: { id: conv[1], execution_status: "running" } };
    }
    if (method === "GET" && suffix === "/events/search") {
      return { status: 200, body: { items: [{ id: "e1" }], next_page_id: null } };
    }
    if (
      method === "POST" &&
      ["/events", "/run", "/pause", "/interrupt", "/confirmation_policy", "/events/respond_to_confirmation"].includes(
        suffix,
      )
    ) {
      return { status: 200, body: { success: true } };
    }
  }
  return { status: 404, body: { detail: "Not Found" } };
}

export async function startMockOpenHandsServer(expectedKey: string): Promise<MockOpenHandsServer> {
  const requests: RecordedRequest[] = [];
  let rules: MockRule[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://mock.local");
      const method = req.method ?? "GET";
      const body = await readBody(req);
      requests.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: { ...req.headers },
        body,
      });

      const rule = rules.find(
        (candidate) =>
          matches(candidate, method, url.pathname) && (candidate.times === undefined || candidate.times > 0),
      );
      if (rule) {
        if (rule.times !== undefined) {
          rule.times -= 1;
        }
        if (rule.hang === true) {
          return;
        }
        if (rule.stallBody === true || rule.abortBody === true) {
          res.writeHead(rule.status ?? 200, { "content-type": "application/json", ...rule.headers });
          res.write('{"partial":');
          if (rule.abortBody === true) {
            setTimeout(() => res.destroy(), 10);
          }
          return;
        }
        if (rule.bodyBytes !== undefined) {
          res.writeHead(rule.status ?? 200, { "content-type": "application/json", ...rule.headers });
          res.end(JSON.stringify({ pad: "x".repeat(rule.bodyBytes) }));
          return;
        }
        if (rule.raw !== undefined) {
          res.writeHead(rule.status ?? 200, { "content-type": "application/json", ...rule.headers });
          res.end(rule.raw);
          return;
        }
        res.writeHead(rule.status ?? 500, { "content-type": "application/json", ...rule.headers });
        res.end(JSON.stringify(rule.body ?? { detail: "forced" }));
        return;
      }

      const needsKey = url.pathname.startsWith("/api/");
      if (needsKey && req.headers["x-session-api-key"] !== expectedKey) {
        sendJson(res, 401, { detail: "Unauthorized" });
        return;
      }
      const result = route(method, url.pathname, body);
      sendJson(res, result.status, result.body);
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    expectedKey,
    addRule: (rule) => {
      rules.push({ ...rule });
    },
    clearRules: () => {
      rules = [];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
