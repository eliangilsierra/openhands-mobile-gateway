import type { Logger } from "../logger.js";
import { NotFoundError, OpenHandsError, UnavailableError } from "../openhands/errors.js";
import type { OpenHandsRestClient } from "../openhands/rest.js";
import type { ConfirmationPolicyRequest } from "../openhands/types.js";
import type { PendingConfirmationRepository } from "../store/pending-confirmation.js";
import { sanitizeDetail, type OpenHandsEvent } from "./translate.js";

/**
 * Confirmations (architecture §7.3, FR-6, T-B1-3). Channel-neutral: no Telegram types.
 *
 * Lifecycle of a `pending_confirmation` row: created when the prompt is about to be sent,
 * bound to the prompt message once sent, and resolved exactly once: by the first valid answer
 * (`allow`/`deny`), or as `expired` / `send_failed`. The row is claimed (resolved) BEFORE the
 * upstream call, so two concurrent taps produce one `respond_to_confirmation` call.
 */

export const DEFAULT_CONFIRMATION_TTL_SECONDS = 3600;

/**
 * Body of `POST /api/conversations/{id}/confirmation_policy` (call 10): the agent-server's
 * `SetConfirmationPolicyRequest` is `{ policy: ConfirmationPolicyBase }`, where the policy is a
 * discriminated union on `kind` (`AlwaysConfirm` | `NeverConfirm` | `ConfirmRisky`). Taken from
 * the OpenHands software-agent-sdk source; NOT yet read from a live `/openapi.json` (see the PR).
 */
export const ALWAYS_CONFIRM_POLICY: ConfirmationPolicyRequest = Object.freeze({
  policy: Object.freeze({ kind: "AlwaysConfirm" }),
});

export type ConfirmationDecision = "allow" | "deny";

/** `callback_data` is `c:<pending_confirmation.id>:<a|d>`: at most 64 bytes, no UUIDs (R3-E2). */
export const CALLBACK_DATA_MAX_BYTES = 64;
const CALLBACK_PATTERN = /^c:([1-9][0-9]{0,14}):([ad])$/;

export function encodeCallbackData(id: number, decision: ConfirmationDecision): string {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RangeError("confirmation id must be a positive safe integer");
  }
  return `c:${String(id)}:${decision === "allow" ? "a" : "d"}`;
}

export interface DecodedCallback {
  readonly id: number;
  readonly decision: ConfirmationDecision;
}

/** Strict decoder: anything that is not exactly our format (forged, truncated, padded) is `null`. */
export function decodeCallbackData(data: string): DecodedCallback | null {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    return null;
  }
  const match = CALLBACK_PATTERN.exec(data);
  if (match === null) {
    return null;
  }
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) {
    return null;
  }
  return { id, decision: match[2] === "a" ? "allow" : "deny" };
}

export type ConfirmationStore = Pick<
  PendingConfirmationRepository,
  "create" | "findById" | "findByAction" | "resolve" | "reopen" | "setChannelMessageId"
>;
export type ConfirmationClient = Pick<OpenHandsRestClient, "setConfirmationPolicy" | "respondToConfirmation">;

export interface ConfirmationServiceDeps {
  readonly store: ConfirmationStore;
  readonly client: ConfirmationClient;
  readonly logger?: Logger;
  /** `CONFIRMATION_TTL_SECONDS`; defaults to {@link DEFAULT_CONFIRMATION_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

export interface ConfirmationRequest {
  readonly conversationId: string;
  readonly actionEventId: string;
  readonly channel: string;
  readonly externalChatId: string;
}

/** Sends the prompt for pending row `id` and returns the channel's message id. */
export type SendPrompt = (id: number) => Promise<string>;

export type RequestResult =
  | { readonly status: "sent"; readonly id: number }
  /** A prompt for this action event already exists (replayed event); nothing was sent. */
  | { readonly status: "duplicate"; readonly id: number }
  | { readonly status: "send_failed" };

export interface AnswerRequest {
  readonly id: number;
  readonly decision: ConfirmationDecision;
  readonly channel: string;
  readonly externalChatId: string;
  /** The message that carried the tapped keyboard; must be the prompt message of the row. */
  readonly channelMessageId?: string;
}

export type AnswerResult =
  | { readonly status: "answered"; readonly decision: ConfirmationDecision }
  | { readonly status: "expired" }
  | { readonly status: "already_resolved" }
  | { readonly status: "wrong_chat" }
  | { readonly status: "not_found" }
  /** OpenHands has no such conversation any more; the prompt is closed. */
  | { readonly status: "conversation_gone" }
  /** The request may have reached OpenHands (timeout/502/504): closed, not retried. */
  | { readonly status: "outcome_unknown" }
  /** The call provably failed; the prompt stays open so the user can tap again. */
  | { readonly status: "failed" };

export class ConfirmationService {
  private readonly store: ConfirmationStore;
  private readonly client: ConfirmationClient;
  private readonly logger: Logger | undefined;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(deps: ConfirmationServiceDeps) {
    this.store = deps.store;
    this.client = deps.client;
    this.logger = deps.logger;
    this.ttlMs = (deps.ttlSeconds ?? DEFAULT_CONFIRMATION_TTL_SECONDS) * 1000;
    this.now = deps.now ?? (() => new Date());
  }

  /** Puts a freshly created conversation in confirmation mode (call 10). Errors propagate. */
  async enablePolicy(conversationId: string): Promise<void> {
    await this.client.setConfirmationPolicy(conversationId, ALWAYS_CONFIRM_POLICY);
  }

  /** Creates the row, sends the prompt, binds the message id. Idempotent per action event. */
  async request(input: ConfirmationRequest, send: SendPrompt): Promise<RequestResult> {
    const existing = this.store.findByAction(input.conversationId, input.actionEventId);
    if (existing !== null) {
      return { status: "duplicate", id: existing.id };
    }
    const row = this.store.create({ ...input, channelMessageId: "" });
    try {
      const messageId = await send(row.id);
      this.store.setChannelMessageId(row.id, messageId);
      return { status: "sent", id: row.id };
    } catch (error) {
      this.store.resolve(row.id, "send_failed");
      this.logger?.warn("Confirmation prompt could not be sent", {
        event: "confirmation.send_failed",
        confirmation_id: row.id,
        err_type: error instanceof Error ? error.name : typeof error,
      });
      return { status: "send_failed" };
    }
  }

  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const row = this.store.findById(request.id);
    if (row === null) {
      return this.reject(request.id, { status: "not_found" });
    }
    // Bound to chat (and to the prompt message): checked before anything else is revealed.
    if (
      row.channel !== request.channel ||
      row.externalChatId !== request.externalChatId ||
      (request.channelMessageId !== undefined && row.channelMessageId !== request.channelMessageId)
    ) {
      return this.reject(request.id, { status: "wrong_chat" });
    }
    if (row.resolvedAt !== null) {
      return this.reject(request.id, { status: "already_resolved" });
    }
    const age = this.now().getTime() - Date.parse(row.createdAt);
    if (!(age < this.ttlMs)) {
      this.store.resolve(request.id, "expired");
      return this.reject(request.id, { status: "expired" });
    }
    // Claim first: the atomic `resolved_at IS NULL` update lets exactly one tap through.
    if (!this.store.resolve(request.id, request.decision)) {
      return this.reject(request.id, { status: "already_resolved" });
    }

    try {
      await this.client.respondToConfirmation(row.conversationId, {
        accept: request.decision === "allow",
        reason: `${request.channel} user decision`,
      });
    } catch (error) {
      return this.afterUpstreamFailure(request, error);
    }
    this.logger?.info("Confirmation answered", {
      event: "confirmation.answered",
      confirmation_id: request.id,
      decision: request.decision,
    });
    return { status: "answered", decision: request.decision };
  }

  private afterUpstreamFailure(request: AnswerRequest, error: unknown): AnswerResult {
    const errType = error instanceof Error ? error.name : typeof error;
    if (error instanceof NotFoundError) {
      this.logger?.warn("Confirmation conversation is gone", {
        event: "confirmation.conversation_gone",
        confirmation_id: request.id,
      });
      return { status: "conversation_gone" };
    }
    if (error instanceof UnavailableError && error.outcomeUnknown) {
      this.logger?.warn("Confirmation outcome unknown", {
        event: "confirmation.outcome_unknown",
        confirmation_id: request.id,
        err_type: errType,
      });
      return { status: "outcome_unknown" };
    }
    // The call did not happen (or was refused): give the prompt back so the user can retry.
    this.store.reopen(request.id, request.decision);
    this.logger?.warn("Confirmation response failed", {
      event: "confirmation.respond_failed",
      confirmation_id: request.id,
      err_type: errType,
      openhands_error: error instanceof OpenHandsError,
    });
    return { status: "failed" };
  }

  private reject(id: number, result: AnswerResult): AnswerResult {
    this.logger?.info("Confirmation callback rejected", {
      event: "confirmation.rejected",
      confirmation_id: id,
      reason: result.status,
    });
    return result;
  }
}

export const MAX_PROMPT_DETAIL_LENGTH = 200;

/** Plain-text prompt for the action awaiting approval (summary preferred, else the tool name). */
export function confirmationPromptText(event: OpenHandsEvent): string {
  const summary = typeof event["summary"] === "string" ? event["summary"] : undefined;
  const tool = typeof event["tool_name"] === "string" ? event["tool_name"] : undefined;
  const detail = sanitizeDetail(summary ?? tool ?? "", MAX_PROMPT_DETAIL_LENGTH);
  return detail === ""
    ? "⏳ OpenHands necesita tu confirmación para continuar."
    : `⏳ OpenHands pide confirmación: ${detail}`;
}
