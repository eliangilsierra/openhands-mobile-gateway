/**
 * Request/response shapes for the 14 REST calls of architecture §21.
 *
 * Only the fields the Gateway reads or writes are typed; upstream may add more, so every
 * response type keeps an index signature. Anything marked "unverified" in §21 stays loose.
 */

export interface ServerInfo {
  readonly version?: string;
  readonly sdk_version?: string;
  readonly [key: string]: unknown;
}

export interface OpenApiDocument {
  readonly paths?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface CreateConversationRequest {
  readonly workspace: { readonly working_dir: string };
  readonly initial_message?: string;
}

export interface ConversationInfo {
  readonly id: string;
  readonly execution_status?: string;
  readonly [key: string]: unknown;
}

export interface SendEventRequest {
  readonly role: "user";
  readonly content: string;
  readonly run: boolean;
}

/** Body shape is "to confirm from /openapi.json" (§7.3, §21 call 10), so it stays open. */
export type ConfirmationPolicyRequest = Readonly<Record<string, unknown>>;

export interface RespondToConfirmationRequest {
  readonly accept: boolean;
  readonly reason: string;
}

export interface SearchEventsParams {
  readonly timestamp__gte?: string;
  readonly limit?: number;
}

export interface EventPage {
  readonly items?: readonly Readonly<Record<string, unknown>>[];
  readonly next_page_id?: string | null;
  readonly [key: string]: unknown;
}

export type SubdirsResult = Readonly<Record<string, unknown>> | readonly unknown[];

export type WorkspaceList = Readonly<Record<string, unknown>> | readonly unknown[];
