import type { Logger } from "../logger.js";
import {
  AuthError,
  ConflictError,
  NotFoundError,
  OpenHandsError,
  UnavailableError,
  UnexpectedResponseError,
  type OpenHandsErrorContext,
} from "./errors.js";
import type {
  ConfirmationPolicyRequest,
  ConversationInfo,
  CreateConversationRequest,
  EventPage,
  OpenApiDocument,
  RespondToConfirmationRequest,
  SearchEventsParams,
  SendEventRequest,
  ServerInfo,
  SubdirsResult,
  WorkspaceList,
} from "./types.js";

/**
 * The only module that talks HTTP to `agentcanvas` (architecture §21, "Exactly these, and
 * nothing else"; ADR-0002, ADR-0007). No other module may hold the API key or call `fetch`;
 * `test/openhands/rest.test.ts` enforces that over `src/`.
 *
 * REST calls (numbers as in §21; call 15, the WebSocket, belongs to the event subscriber):
 *  1. GET  /server_info
 *  2. GET  /openapi.json
 *  3. POST /api/conversations
 *  4. GET  /api/conversations/{id}
 *  5. GET  /api/conversations/count
 *  6. POST /api/conversations/{id}/events
 *  7. POST /api/conversations/{id}/run
 *  8. POST /api/conversations/{id}/pause
 *  9. POST /api/conversations/{id}/interrupt
 * 10. POST /api/conversations/{id}/confirmation_policy
 * 11. POST /api/conversations/{id}/events/respond_to_confirmation
 * 12. GET  /api/conversations/{id}/events/search
 * 13. GET  /api/file/search_subdirs
 * 14. GET  /api/workspaces
 *
 * Authentication: `X-Session-API-Key` is built in exactly one place (`attempt`) and therefore
 * rides on every request, including each retry (ADR-0007 decision 1). Redirects are never
 * followed (`redirect: "manual"`), and any 3xx is an UnexpectedResponseError.
 *
 * Error mapping (§7.2): 401 -> AuthError; 404 on a conversation call -> NotFoundError; 409 on
 * `/run` -> ConflictError; 502/503/504, timeouts and refused connections -> UnavailableError;
 * other non-2xx and malformed 2xx JSON -> UnexpectedResponseError (never retried).
 * Only GET calls are retried (exponential backoff with jitter); POSTs never are, in
 * particular `POST .../events`, which would duplicate a task. A POST that fails without a
 * response, or that ends in 502/504, has `outcomeUnknown === true`: the server (or a proxy in
 * front of it) may have processed it.
 *
 * Timeouts: one per-request timeout (`requestTimeoutMs`, 30 s) bounds the whole request;
 * there is no separate connect timeout (accepted deviation, see the PR). The package
 * `@openhands/typescript-client` exposes no way to disable redirects, so the transport is a
 * thin `fetch` wrapper here (the fallback ADR-0002 names).
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 250;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface RetryOptions {
  /** Total attempts for a GET (first try included). */
  readonly maxAttempts?: number;
  /** Delay before retry `n` (1-based) is `baseDelayMs * 2^(n-1)`. */
  readonly baseDelayMs?: number;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); injectable for tests. */
  readonly random?: () => number;
}

export interface OpenHandsRestClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requestTimeoutMs?: number;
  /** Cap on a 2xx response body; larger bodies are an UnexpectedResponseError. Default 5 MiB. */
  readonly maxResponseBytes?: number;
  readonly retry?: RetryOptions;
  readonly logger?: Logger;
}

export interface OpenHandsRestClient {
  getServerInfo(): Promise<ServerInfo>;
  getOpenApi(): Promise<OpenApiDocument>;
  createConversation(request: CreateConversationRequest): Promise<ConversationInfo>;
  getConversation(id: string): Promise<ConversationInfo>;
  countConversations(): Promise<number>;
  sendEvent(id: string, request: SendEventRequest): Promise<unknown>;
  runConversation(id: string): Promise<unknown>;
  pauseConversation(id: string): Promise<unknown>;
  interruptConversation(id: string): Promise<unknown>;
  setConfirmationPolicy(id: string, policy: ConfirmationPolicyRequest): Promise<unknown>;
  respondToConfirmation(id: string, response: RespondToConfirmationRequest): Promise<unknown>;
  searchEvents(id: string, params?: SearchEventsParams): Promise<EventPage>;
  searchSubdirs(path: string): Promise<SubdirsResult>;
  listWorkspaces(): Promise<WorkspaceList>;
}

interface CallSpec {
  readonly method: "GET" | "POST";
  /** Route template used in errors and logs. */
  readonly route: string;
  /** Concrete path with encoded parameters. */
  readonly path: string;
  readonly params?: Record<string, unknown>;
  readonly body?: unknown;
  /** True for routes under `/api/conversations/{id}`: a 404 means the conversation is gone. */
  readonly conversationScoped?: boolean;
  /** True for `/run`: a 409 means it is already running. */
  readonly conflictMeansRunning?: boolean;
}

const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** SR-1: UUID / hex-dash style ids only; rejects `.`, `..`, slashes, encodings and whitespace. */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function pathId(id: string): string {
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw new TypeError("conversation id has an invalid format");
  }
  return id;
}

/** SR-3: only http/https base URLs; returned without a trailing slash. */
function parseBaseUrl(value: string): string {
  // A bare `?` or `#` leaves URL.search/hash empty, so check the raw string as well.
  if (/[?#]/.test(value)) {
    throw new TypeError("OPENHANDS_BASE_URL must not contain a query or fragment");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("OPENHANDS_BASE_URL must be a valid URL", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("OPENHANDS_BASE_URL must use http or https");
  }
  // NIT-1: credentials, query and fragment would be silently mangled or leaked into requests.
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("OPENHANDS_BASE_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError("OPENHANDS_BASE_URL must not contain a query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function mapHttpStatus(status: number, spec: CallSpec): OpenHandsError {
  const context: OpenHandsErrorContext = { method: spec.method, route: spec.route, status };
  if (status === 401) {
    return new AuthError(context);
  }
  if (status === 404 && spec.conversationScoped === true) {
    return new NotFoundError(context);
  }
  if (status === 409 && spec.conflictMeansRunning === true) {
    return new ConflictError(context);
  }
  if (UNAVAILABLE_STATUSES.has(status)) {
    return new UnavailableError(context);
  }
  return new UnexpectedResponseError(context);
}

export function createOpenHandsRestClient(options: OpenHandsRestClientOptions): OpenHandsRestClient {
  // Defensive repeat of the boot-time check in config.ts (architecture §9.1 B4).
  if (options.apiKey.trim().length === 0) {
    throw new TypeError("OPENHANDS_API_KEY must not be empty");
  }
  if (options.baseUrl.trim().length === 0) {
    throw new TypeError("OPENHANDS_BASE_URL must not be empty");
  }

  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
  const sleep =
    options.retry?.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const logger = options.logger;

  const base = parseBaseUrl(options.baseUrl);
  const apiKey = options.apiKey;
  const random = options.retry?.random ?? Math.random;

  async function attempt<T>(spec: CallSpec): Promise<T> {
    const context: OpenHandsErrorContext = { method: spec.method, route: spec.route };
    const url = new URL(base + spec.path);
    for (const [key, value] of Object.entries(spec.params ?? {})) {
      url.searchParams.append(key, String(value));
    }
    const headers: Record<string, string> = { "X-Session-API-Key": apiKey };
    if (spec.method === "POST") {
      headers["Content-Type"] = "application/json";
    }

    const signal = AbortSignal.timeout(timeout);
    let response: Response;
    try {
      response = await fetch(url, {
        method: spec.method,
        headers,
        // SR-2: never follow a redirect, so the key cannot be replayed to another origin.
        redirect: "manual",
        signal,
        ...(spec.method === "POST" && spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      });
    } catch (error) {
      // Timeout or connection failure: no HTTP status. The cause is a fetch/abort error and
      // never contains request headers.
      throw new UnavailableError(context, { cause: error });
    }

    // CR-7: decide from the status alone, before touching the body. Any non-2xx (including
    // every 3xx) is mapped without reading the body, so a stalled or hostile error body can
    // neither change the mapping nor carry the key into an error or log line (LOW-1).
    if (response.status < 200 || response.status > 299) {
      void response.body?.cancel().catch(() => undefined);
      throw mapHttpStatus(response.status, spec);
    }

    const text = await readCappedText(response, context);
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      // CR-1: a malformed 2xx body is a protocol problem, not an outage; never retried.
      throw new UnexpectedResponseError({ ...context, status: response.status }, { cause: error });
    }
  }

  /** Reads a 2xx body through a byte cap (LOW-1). Read failure or timeout is an outage. */
  async function readCappedText(
    response: Response,
    context: OpenHandsErrorContext,
  ): Promise<string> {
    const body = response.body;
    if (body === null) {
      return "";
    }
    const tooLarge = (): UnexpectedResponseError =>
      new UnexpectedResponseError({ ...context, status: response.status });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      void body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received += value.byteLength;
        if (received > maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof UnexpectedResponseError) {
        throw error;
      }
      throw new UnavailableError(context, { cause: error });
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  async function call<T>(spec: CallSpec): Promise<T> {
    const retryable = spec.method === "GET";
    const attempts = retryable ? maxAttempts : 1;
    for (let n = 1; ; n += 1) {
      try {
        return await attempt<T>(spec);
      } catch (error) {
        if (error instanceof AuthError) {
          logger?.error("OpenHands rejected the API key", {
            event: "openhands.auth_failed",
            status: 401,
          });
        }
        if (!(error instanceof UnavailableError) || n >= attempts) {
          throw error;
        }
        logger?.warn("OpenHands read failed, retrying", {
          event: "openhands.retry",
          ...(error.status !== undefined ? { status: error.status } : {}),
          err_type: error.name,
        });
        // SR-4: up to +20% jitter so concurrent readers do not retry in lockstep.
        await sleep(Math.round(baseDelayMs * 2 ** (n - 1) * (1 + 0.2 * random())));
      }
    }
  }

  const conv = (id: string, suffix = ""): { path: string; template: string } => ({
    path: `/api/conversations/${pathId(id)}${suffix}`,
    template: `/api/conversations/{id}${suffix}`,
  });

  async function post(id: string, suffix: string, body?: unknown, conflict = false): Promise<unknown> {
    const { path, template } = conv(id, suffix);
    return call({
      method: "POST",
      route: template,
      path,
      body,
      conversationScoped: true,
      conflictMeansRunning: conflict,
    });
  }

  return {
    getServerInfo: () => call({ method: "GET", route: "/server_info", path: "/server_info" }),
    getOpenApi: () => call({ method: "GET", route: "/openapi.json", path: "/openapi.json" }),
    createConversation: (request) =>
      call({ method: "POST", route: "/api/conversations", path: "/api/conversations", body: request }),
    getConversation: async (id) => {
      const { path, template } = conv(id);
      return call({ method: "GET", route: template, path, conversationScoped: true });
    },
    countConversations: () =>
      call({
        method: "GET",
        route: "/api/conversations/count",
        path: "/api/conversations/count",
      }),
    sendEvent: (id, request) => post(id, "/events", request),
    runConversation: (id) => post(id, "/run", undefined, true),
    pauseConversation: (id) => post(id, "/pause"),
    interruptConversation: (id) => post(id, "/interrupt"),
    setConfirmationPolicy: (id, policy) => post(id, "/confirmation_policy", policy),
    respondToConfirmation: (id, response) =>
      post(id, "/events/respond_to_confirmation", response),
    searchEvents: async (id, params) => {
      const { path, template } = conv(id, "/events/search");
      return call({
        method: "GET",
        route: template,
        path,
        conversationScoped: true,
        ...(params ? { params: { ...params } } : {}),
      });
    },
    searchSubdirs: (dir) =>
      call({
        method: "GET",
        route: "/api/file/search_subdirs",
        path: "/api/file/search_subdirs",
        params: { path: dir },
      }),
    listWorkspaces: () =>
      call({ method: "GET", route: "/api/workspaces", path: "/api/workspaces" }),
  };
}
