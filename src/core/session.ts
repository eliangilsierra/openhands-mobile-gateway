import type { Logger } from "../logger.js";
import {
  AuthError,
  ConflictError,
  NotFoundError,
  OpenHandsError,
  UnavailableError,
} from "../openhands/errors.js";
import type { OpenHandsRestClient } from "../openhands/rest.js";
import type { ChatStateRepository } from "../store/chat-state.js";
import type { ConversationBinding, ConversationBindingRepository } from "../store/conversation-binding.js";
import type { ProjectRegistry } from "./projects.js";

/**
 * Session Orchestrator (architecture §7.2, FR-1). Channel-neutral: no Telegram types.
 *
 * The task text is only ever placed in a JSON body by the REST client; it is never interpolated
 * into a URL, a path or a command, and it is never logged.
 */

export const DEFAULT_MAX_TASK_CHARS = 8000;

export interface SubmitTaskDeps {
  readonly registry: Pick<ProjectRegistry, "resolve">;
  readonly chatState: Pick<ChatStateRepository, "getActiveProject">;
  readonly bindings: Pick<ConversationBindingRepository, "findActive" | "create" | "markStale" | "touchLastUsed">;
  readonly client: Pick<OpenHandsRestClient, "createConversation" | "sendEvent">;
  readonly logger?: Logger;
  /**
   * Lifecycle hook: the conversation became active (task delivered), so its event subscription
   * should be opened. Idempotent on the subscriber side; a failure never fails the task.
   */
  readonly activate?: (conversationId: string) => void;
  /** `MAX_TASK_CHARS`; defaults to {@link DEFAULT_MAX_TASK_CHARS}. */
  readonly maxTaskChars?: number;
}

export type SubmitTaskResult =
  | { readonly status: "created" }
  | { readonly status: "sent" }
  /** The stored conversation was gone upstream: binding marked stale, a fresh one was created. */
  | { readonly status: "recreated" }
  | { readonly status: "invalid_text"; readonly reason: "empty" | "too_long"; readonly max: number }
  | { readonly status: "no_active_project" }
  | { readonly status: "project_not_found" }
  | { readonly status: "no_source" }
  | { readonly status: "unavailable" }
  | { readonly status: "auth_error" }
  | { readonly status: "already_running" }
  /** The task may have reached OpenHands (timeout, 502/504, or the binding could not be saved). Do not resend blindly. */
  | { readonly status: "outcome_unknown" }
  | { readonly status: "error" };

type Failure = Exclude<SubmitTaskResult, { status: "created" | "sent" | "recreated" }>;

interface Target {
  readonly channel: string;
  readonly externalChatId: string;
}

function failureFor(error: unknown, logger: Logger | undefined): Failure {
  const fields = {
    err_type: error instanceof Error ? error.name : typeof error,
    ...(error instanceof OpenHandsError && error.status !== undefined ? { status: error.status } : {}),
  };
  if (error instanceof AuthError) {
    logger?.error("OpenHands rejected the API key", { event: "session.auth_failed", ...fields });
    return { status: "auth_error" };
  }
  if (error instanceof ConflictError) {
    logger?.warn("Conversation is already running", { event: "session.conflict", ...fields });
    return { status: "already_running" };
  }
  if (error instanceof UnavailableError) {
    logger?.warn("OpenHands unavailable", {
      event: "session.unavailable",
      ...fields,
      ...(error.outcomeUnknown ? { kind: "outcome_unknown" } : {}),
    });
    return { status: error.outcomeUnknown ? "outcome_unknown" : "unavailable" };
  }
  logger?.error("Task submission failed", { event: "session.submit_failed", ...fields });
  return { status: "error" };
}

/**
 * `SendTask` intent. `acknowledge` is called at most once, after the local checks and before any
 * OpenHands round trip, so the user sees "received" within the FR-1 budget. Its own failure is
 * logged and never blocks the task.
 */
export async function submitTask(
  deps: SubmitTaskDeps,
  target: Target,
  text: string,
  acknowledge: () => Promise<void>,
): Promise<SubmitTaskResult> {
  const { logger } = deps;
  const max = deps.maxTaskChars ?? DEFAULT_MAX_TASK_CHARS;
  if (text.trim().length === 0) {
    return { status: "invalid_text", reason: "empty", max };
  }
  if (text.length > max) {
    return { status: "invalid_text", reason: "too_long", max };
  }

  const ack = async (): Promise<void> => {
    try {
      await acknowledge();
    } catch (error) {
      logger?.warn("Acknowledgement failed", {
        event: "session.ack_failed",
        err_type: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  try {
    const projectKey = deps.chatState.getActiveProject(target.channel, target.externalChatId);
    if (projectKey === null) {
      return { status: "no_active_project" };
    }
    await ack();
    // Serialised per chat+project so two concurrent submissions cannot both create a conversation.
    return await withInFlightGuard(deps, [target.channel, target.externalChatId, projectKey], async () => {
      const binding = deps.bindings.findActive(target.channel, target.externalChatId, projectKey);
      if (binding !== null) {
        return await sendToExisting(deps, binding, text, target);
      }
      const resolved = await resolveProject(deps, projectKey);
      if (resolved.status !== "found") {
        return resolved;
      }
      return await createAndBind(deps, target, projectKey, resolved.workingDir, text, "created");
    });
  } catch (error) {
    return failureFor(error, logger);
  }
}

type Resolved = { readonly status: "found"; readonly workingDir: string } | Failure;

async function resolveProject(deps: SubmitTaskDeps, projectKey: string): Promise<Resolved> {
  const resolved = await deps.registry.resolve(projectKey);
  if (resolved.status === "found") {
    return { status: "found", workingDir: resolved.project.workingDir };
  }
  return { status: resolved.status === "not_found" ? "project_not_found" : resolved.status };
}

const guards = new WeakMap<object, Map<string, Promise<void>>>();

/** Runs `fn` after every earlier call with the same key (per bindings store) has settled. */
async function withInFlightGuard<T>(deps: SubmitTaskDeps, key: readonly string[], fn: () => Promise<T>): Promise<T> {
  let chains = guards.get(deps.bindings);
  if (chains === undefined) {
    chains = new Map();
    guards.set(deps.bindings, chains);
  }
  const id = JSON.stringify(key);
  const run = (chains.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, tail);
  try {
    return await run;
  } finally {
    if (chains.get(id) === tail) {
      chains.delete(id);
    }
  }
}

async function sendToExisting(
  deps: SubmitTaskDeps,
  binding: ConversationBinding,
  text: string,
  target: Target,
): Promise<SubmitTaskResult> {
  try {
    // Never retried here: a repeated POST .../events would duplicate the task (architecture §7.2).
    await deps.client.sendEvent(binding.conversationId, { role: "user", content: text, run: true });
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
    return await recreate(deps, binding, text, target);
  }
  // Bookkeeping only: the task is already delivered, so a failure here must not become an error reply.
  try {
    deps.bindings.touchLastUsed(binding.conversationId);
  } catch (error) {
    deps.logger?.warn("Could not update last_used_at", {
      event: "session.touch_failed",
      err_type: error instanceof Error ? error.name : typeof error,
    });
  }
  activate(deps, binding.conversationId);
  return { status: "sent" };
}

function activate(deps: SubmitTaskDeps, conversationId: string): void {
  try {
    deps.activate?.(conversationId);
  } catch (error) {
    deps.logger?.warn("Could not open the event subscription", {
      event: "session.activate_failed",
      conversation_id: conversationId,
      err_type: error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * The stored conversation is gone upstream. The project is re-resolved first (the registry, not the
 * working_dir stored at bind time, is the authority) and the replacement is created before the old
 * binding is marked stale, so a failed resolve or create leaves the old binding as it was and the
 * next message reports the loss again.
 */
async function recreate(
  deps: SubmitTaskDeps,
  binding: ConversationBinding,
  text: string,
  target: Target,
): Promise<SubmitTaskResult> {
  const resolved = await resolveProject(deps, binding.projectKey);
  if (resolved.status !== "found") {
    return resolved;
  }
  deps.logger?.warn("Conversation not found upstream; binding marked stale", {
    event: "session.binding_stale",
    channel: target.channel,
    project_key: binding.projectKey,
  });
  return await createAndBind(deps, target, binding.projectKey, resolved.workingDir, text, "recreated", binding);
}

async function createAndBind(
  deps: SubmitTaskDeps,
  target: Target,
  projectKey: string,
  workingDir: string,
  text: string,
  status: "created" | "recreated",
  stale?: ConversationBinding,
): Promise<SubmitTaskResult> {
  const info = await deps.client.createConversation({
    workspace: { working_dir: workingDir },
    initial_message: text,
  });
  try {
    if (stale !== undefined) {
      deps.bindings.markStale(stale.conversationId);
    }
    deps.bindings.create({
      channel: target.channel,
      externalChatId: target.externalChatId,
      projectKey,
      workingDir,
      conversationId: info.id,
    });
  } catch (error) {
    // The conversation is already running upstream with the task but is not bound. Answering "error"
    // would invite a resend (a second run), so report outcome_unknown; the id lets an operator recover it.
    deps.logger?.error("Conversation created but binding failed", {
      event: "session.bind_failed",
      channel: target.channel,
      project_key: projectKey,
      conversation_id: info.id,
      err_type: error instanceof Error ? error.name : typeof error,
    });
    return { status: "outcome_unknown" };
  }
  activate(deps, info.id);
  deps.logger?.info("Conversation created", {
    event: "session.conversation_created",
    channel: target.channel,
    project_key: projectKey,
  });
  return { status };
}

/**
 * Session controls (architecture §7.1 command table, FR-5): status, pause, resume and stop act on the
 * chat's active binding. Only validated OpenHands calls are made: `GET /api/conversations/{id}` (4),
 * `POST .../run` (7), `POST .../pause` (8) and `POST .../interrupt` (9). There is no upstream
 * "resume" route; resume is `run`. None of them deletes the conversation.
 */

export interface SessionControlDeps {
  readonly chatState: Pick<ChatStateRepository, "getActiveProject">;
  readonly bindings: Pick<ConversationBindingRepository, "findActive">;
  readonly client: Pick<
    OpenHandsRestClient,
    "getConversation" | "pauseConversation" | "runConversation" | "interruptConversation"
  >;
  readonly logger?: Logger;
  /** Keeps the event subscriber's idle timer in step with the conversation (`EventSubscriber.setTerminal`). */
  readonly setTerminal?: (conversationId: string, terminal: boolean) => void;
}

/**
 * `ConversationExecutionStatus` as reported by `GET /api/conversations/{id}`. This is the agent's
 * execution status, never the runtime (sandbox) status (R2-F14); `unknown` covers a missing or
 * unrecognised value, which is never echoed back to the user.
 */
export type ExecutionStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_for_confirmation"
  | "finished"
  | "error"
  | "stuck"
  | "unknown";

const EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "running",
  "paused",
  "waiting_for_confirmation",
  "finished",
  "error",
  "stuck",
]);

const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(["finished", "error", "stuck"]);

export function normalizeExecutionStatus(value: unknown): ExecutionStatus {
  return typeof value === "string" && EXECUTION_STATUSES.has(value) ? (value as ExecutionStatus) : "unknown";
}

export type SessionControlFailure =
  | { readonly status: "no_active_binding" }
  /** The conversation no longer exists upstream. */
  | { readonly status: "conversation_gone" }
  | { readonly status: "unavailable" }
  /** A POST may have been processed (timeout, 502/504). Do not assume it failed. */
  | { readonly status: "outcome_unknown" }
  | { readonly status: "auth_error" }
  | { readonly status: "already_running" }
  | { readonly status: "error" };

export type GetStatusResult =
  | { readonly status: "ok"; readonly executionStatus: ExecutionStatus }
  | SessionControlFailure;
export type SessionControlResult = { readonly status: "ok" } | SessionControlFailure;

function controlFailure(error: unknown, logger: Logger | undefined, action: string): SessionControlFailure {
  if (error instanceof NotFoundError) {
    logger?.warn("Conversation not found upstream", { event: "session.control_gone", action });
    return { status: "conversation_gone" };
  }
  const mapped = failureFor(error, logger);
  switch (mapped.status) {
    case "auth_error":
    case "already_running":
    case "unavailable":
    case "outcome_unknown":
      return { status: mapped.status };
    default:
      return { status: "error" };
  }
}

function findBinding(deps: SessionControlDeps, target: Target): ConversationBinding | null {
  const projectKey = deps.chatState.getActiveProject(target.channel, target.externalChatId);
  if (projectKey === null) {
    return null;
  }
  return deps.bindings.findActive(target.channel, target.externalChatId, projectKey);
}

function markTerminal(deps: SessionControlDeps, conversationId: string, terminal: boolean): void {
  try {
    deps.setTerminal?.(conversationId, terminal);
  } catch (error) {
    deps.logger?.warn("Could not update the subscription state", {
      event: "session.set_terminal_failed",
      err_type: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function control(
  deps: SessionControlDeps,
  target: Target,
  action: "pause" | "resume" | "stop",
  call: (id: string) => Promise<unknown>,
  after?: (id: string) => void,
): Promise<SessionControlResult> {
  try {
    const binding = findBinding(deps, target);
    if (binding === null) {
      return { status: "no_active_binding" };
    }
    await call(binding.conversationId);
    after?.(binding.conversationId);
    deps.logger?.info("Session control applied", { event: "session.control", action, channel: target.channel });
    return { status: "ok" };
  } catch (error) {
    return controlFailure(error, deps.logger, action);
  }
}

/** `/status`: the conversation's execution status. */
export async function getStatus(deps: SessionControlDeps, target: Target): Promise<GetStatusResult> {
  try {
    const binding = findBinding(deps, target);
    if (binding === null) {
      return { status: "no_active_binding" };
    }
    const info = await deps.client.getConversation(binding.conversationId);
    const executionStatus = normalizeExecutionStatus(info.execution_status);
    if (executionStatus !== "unknown") {
      markTerminal(deps, binding.conversationId, TERMINAL_STATUSES.has(executionStatus));
    }
    return { status: "ok", executionStatus };
  } catch (error) {
    return controlFailure(error, deps.logger, "status");
  }
}

/** `/pause`: `POST /api/conversations/{id}/pause`. */
export function pauseTask(deps: SessionControlDeps, target: Target): Promise<SessionControlResult> {
  return control(deps, target, "pause", (id) => deps.client.pauseConversation(id));
}

/** `/resume`: `POST /api/conversations/{id}/run` (no `/resume` route exists upstream, R2-F8). */
export function resumeTask(deps: SessionControlDeps, target: Target): Promise<SessionControlResult> {
  return control(
    deps,
    target,
    "resume",
    (id) => deps.client.runConversation(id),
    (id) => markTerminal(deps, id, false),
  );
}

/** `/stop`: `POST /api/conversations/{id}/interrupt`. Parks the conversation; never deletes it (FR-8). */
export function stopTask(deps: SessionControlDeps, target: Target): Promise<SessionControlResult> {
  return control(deps, target, "stop", (id) => deps.client.interruptConversation(id));
}
