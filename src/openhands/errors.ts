/**
 * Typed errors of the OpenHands REST client (architecture §7.2).
 *
 * Messages are built only from the HTTP method, the route template and the status code —
 * never from a response body, a URL query or a header — so no error can carry the API key.
 */

export interface OpenHandsErrorContext {
  /** HTTP method, e.g. `POST`. */
  readonly method: string;
  /** Route template, e.g. `/api/conversations/{id}/run` (never the concrete id or query). */
  readonly route: string;
  /** HTTP status, or `undefined` for transport failures (timeout, connection refused). */
  readonly status?: number | undefined;
}

export class OpenHandsError extends Error {
  readonly method: string;
  readonly route: string;
  readonly status: number | undefined;

  constructor(message: string, context: OpenHandsErrorContext, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenHandsError";
    this.method = context.method;
    this.route = context.route;
    this.status = context.status;
  }
}

/** `401`: the OpenHands API key is not accepted (health becomes `degraded`). */
export class AuthError extends OpenHandsError {
  constructor(context: OpenHandsErrorContext) {
    super(`OpenHands rejected the API key (${context.method} ${context.route})`, context);
    this.name = "AuthError";
  }
}

/** `404` on a conversation call: the conversation no longer exists upstream (binding is stale). */
export class NotFoundError extends OpenHandsError {
  constructor(context: OpenHandsErrorContext) {
    super(`OpenHands resource not found (${context.method} ${context.route})`, context);
    this.name = "NotFoundError";
  }
}

/** `409` on `/run`: the conversation is already running. */
export class ConflictError extends OpenHandsError {
  constructor(context: OpenHandsErrorContext) {
    super(`OpenHands conflict (${context.method} ${context.route})`, context);
    this.name = "ConflictError";
  }
}

/** `502/503/504`, a timeout or a refused connection: OpenHands is not reachable. */
export class UnavailableError extends OpenHandsError {
  constructor(context: OpenHandsErrorContext, options?: { cause?: unknown }) {
    const detail = context.status === undefined ? "no response" : `status ${context.status}`;
    super(`OpenHands unavailable: ${detail} (${context.method} ${context.route})`, context, options);
    this.name = "UnavailableError";
  }
}

/** Any other non-2xx status that has no dedicated mapping. */
export class UnexpectedResponseError extends OpenHandsError {
  constructor(context: OpenHandsErrorContext) {
    super(
      `Unexpected OpenHands response ${String(context.status)} (${context.method} ${context.route})`,
      context,
    );
    this.name = "UnexpectedResponseError";
  }
}
