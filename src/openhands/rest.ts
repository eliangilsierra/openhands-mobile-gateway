import { HttpClient, HttpError } from "@openhands/typescript-client/client/http-client";
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
 * Authentication: `X-Session-API-Key` is set once by the wrapped `HttpClient` and therefore
 * rides on every request, including each retry (ADR-0007 decision 1).
 *
 * Error mapping (§7.2): 401 -> AuthError; 404 on a conversation call -> NotFoundError; 409 on
 * `/run` -> ConflictError; 502/503/504, timeouts and refused connections -> UnavailableError.
 * Only GET calls are retried (with exponential backoff); POSTs never are, in particular
 * `POST .../events`, which would duplicate a task.
 *
 * Timeouts: the wrapped client offers a single per-request timeout (fetch, no separate
 * connect phase), so `requestTimeoutMs` (30 s read) bounds the whole request; a hung connect
 * ends in the same UnavailableError. See the PR description for this documented deviation.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 250;

export interface RetryOptions {
  /** Total attempts for a GET (first try included). */
  readonly maxAttempts?: number;
  /** Delay before retry `n` (1-based) is `baseDelayMs * 2^(n-1)`. */
  readonly baseDelayMs?: number;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface OpenHandsRestClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requestTimeoutMs?: number;
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

function pathId(id: string): string {
  if (id.trim().length === 0) {
    throw new TypeError("conversation id must not be empty");
  }
  return encodeURIComponent(id);
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
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
  const sleep =
    options.retry?.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const logger = options.logger;

  const http = new HttpClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, timeout });

  async function attempt<T>(spec: CallSpec): Promise<T> {
    const context: OpenHandsErrorContext = { method: spec.method, route: spec.route };
    try {
      const requestOptions = { timeout, ...(spec.params ? { params: spec.params } : {}) };
      const response =
        spec.method === "GET"
          ? await http.get<T>(spec.path, requestOptions)
          : await http.post<T>(spec.path, spec.body, requestOptions);
      return response.data;
    } catch (error) {
      if (error instanceof HttpError) {
        // Deliberately dropped: the HttpError message embeds the response body.
        throw mapHttpStatus(error.status, spec);
      }
      // Timeout or connection failure: no HTTP status. The cause is a fetch/abort error and
      // never contains request headers.
      throw new UnavailableError(context, { cause: error });
    }
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
          status: error.status ?? 0,
          err_type: error.name,
        });
        await sleep(baseDelayMs * 2 ** (n - 1));
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
