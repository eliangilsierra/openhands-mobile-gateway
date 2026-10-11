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
  return { status: "sent" };
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
  deps.logger?.info("Conversation created", {
    event: "session.conversation_created",
    channel: target.channel,
    project_key: projectKey,
  });
  return { status };
}
