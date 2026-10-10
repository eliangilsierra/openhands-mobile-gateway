import type { Logger } from "../logger.js";
import { OpenHandsError, UnexpectedResponseError } from "../openhands/errors.js";
import type { OpenHandsRestClient } from "../openhands/rest.js";
import type { ChatStateRepository } from "../store/chat-state.js";
import type { ConversationBindingRepository } from "../store/conversation-binding.js";

/**
 * Project Registry (architecture §6, §7.4, ADR-0005). Channel-neutral: no Telegram types.
 *
 * A user-supplied key is never concatenated into a path. It passes three independent controls
 * (T-B2-3) and is then resolved by set membership against a list the registry itself produced.
 */

export const PROJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PROJECTS_CACHE_TTL_MS = 60_000;

export interface ProjectEntry {
  /** The single path segment users type (`/use <key>`). */
  readonly key: string;
  /** Absolute path as the agent-server sees it: `PROJECTS_ROOT + "/" + key`. */
  readonly workingDir: string;
}

/** Control 1: the key matches the allowed shape (rejects `/`, `~`, `$`, backticks, NUL, newlines, `%`). */
export function isValidKeyShape(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key);
}

/** Control 2: the key is not a dot segment. */
export function isDotSegment(key: string): boolean {
  return key === "." || key === "..";
}

/** Control 3: resolve by set membership; returns an entry the registry already produced. */
export function resolveByMembership(key: string, entries: readonly ProjectEntry[]): ProjectEntry | null {
  return entries.find((entry) => entry.key === key) ?? null;
}

/** Control 4: the path is exactly `root + "/" + <one segment>` and that segment is `key`. */
export function isDirectChildOfRoot(root: string, entry: ProjectEntry): boolean {
  const prefix = `${normalizeRoot(root)}/`;
  if (!entry.workingDir.startsWith(prefix)) {
    return false;
  }
  const segment = entry.workingDir.slice(prefix.length);
  return segment === entry.key && isValidKeyShape(segment) && !isDotSegment(segment);
}

function normalizeRoot(root: string): string {
  return root.replace(/\/+$/, "");
}

export type ListProjectsResult =
  | { readonly status: "ok"; readonly projects: readonly ProjectEntry[] }
  /** No source could provide a list (operator must set `PROJECTS`). */
  | { readonly status: "no_source" }
  | { readonly status: "unavailable" };

export type ResolveProjectResult =
  | { readonly status: "found"; readonly project: ProjectEntry }
  | { readonly status: "not_found" }
  | { readonly status: "no_source" }
  | { readonly status: "unavailable" };

export interface ProjectRegistryOptions {
  readonly projectsRoot: string;
  /** `PROJECTS` from config; when non-null it is authoritative. */
  readonly staticProjects: readonly string[] | null;
  readonly client: Pick<OpenHandsRestClient, "searchSubdirs" | "listWorkspaces">;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

function pathsFrom(payload: unknown): string[] {
  const items: unknown = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && "items" in payload
      ? (payload as { items: unknown }).items
      : [];
  if (!Array.isArray(items)) {
    return [];
  }
  const paths: string[] = [];
  for (const item of items as unknown[]) {
    if (typeof item === "string") {
      paths.push(item);
    } else if (typeof item === "object" && item !== null && "path" in item) {
      const path = (item as { path: unknown }).path;
      if (typeof path === "string") {
        paths.push(path);
      }
    }
  }
  return paths;
}

export class ProjectRegistry {
  private readonly root: string;
  private readonly options: ProjectRegistryOptions;
  private readonly now: () => number;
  private readonly ttl: number;
  private cache: { readonly projects: readonly ProjectEntry[]; readonly expiresAt: number } | null = null;

  constructor(options: ProjectRegistryOptions) {
    this.options = options;
    this.root = normalizeRoot(options.projectsRoot);
    this.now = options.now ?? Date.now;
    this.ttl = options.cacheTtlMs ?? PROJECTS_CACHE_TTL_MS;
  }

  /** Resolution order (ADR-0005): static `PROJECTS`, then `search_subdirs`, then `workspaces`. */
  async list(): Promise<ListProjectsResult> {
    if (this.cache !== null && this.now() < this.cache.expiresAt) {
      return { status: "ok", projects: this.cache.projects };
    }
    let result: ListProjectsResult;
    if (this.options.staticProjects !== null) {
      result = { status: "ok", projects: this.fromStatic(this.options.staticProjects) };
    } else {
      result = await this.fromOpenHands();
    }
    if (result.status === "ok") {
      this.cache = { projects: result.projects, expiresAt: this.now() + this.ttl };
    }
    return result;
  }

  /** Validates `key` (controls 1-2 before any lookup or network call), then resolves it. */
  async resolve(key: string): Promise<ResolveProjectResult> {
    if (!isValidKeyShape(key) || isDotSegment(key)) {
      return { status: "not_found" };
    }
    const listed = await this.list();
    if (listed.status !== "ok") {
      return listed;
    }
    const project = resolveByMembership(key, listed.projects);
    if (project === null || !isDirectChildOfRoot(this.root, project)) {
      return { status: "not_found" };
    }
    return { status: "found", project };
  }

  private fromStatic(names: readonly string[]): ProjectEntry[] {
    const entries: ProjectEntry[] = [];
    for (const name of names) {
      if (!isValidKeyShape(name) || isDotSegment(name)) {
        this.options.logger?.warn("Ignoring invalid PROJECTS entry", { event: "projects.static_invalid" });
        continue;
      }
      // Config-origin value, validated above; the only place a path is built from a name.
      entries.push({ key: name, workingDir: `${this.root}/${name}` });
    }
    return dedupe(entries);
  }

  private async fromOpenHands(): Promise<ListProjectsResult> {
    try {
      const payload = await this.options.client.searchSubdirs(this.root);
      return { status: "ok", projects: this.fromPaths(pathsFrom(payload)) };
    } catch (error) {
      if (!(error instanceof UnexpectedResponseError) || (error.status !== 404 && error.status !== 501)) {
        return this.failure(error);
      }
      this.options.logger?.info("search_subdirs unsupported, falling back to workspaces", {
        event: "projects.fallback_workspaces",
        status: error.status,
      });
    }
    try {
      const projects = this.fromPaths(pathsFrom(await this.options.client.listWorkspaces()));
      return projects.length > 0 ? { status: "ok", projects } : { status: "no_source" };
    } catch (error) {
      this.failure(error);
      return { status: "no_source" };
    }
  }

  private failure(error: unknown): ListProjectsResult {
    this.options.logger?.warn("Project listing failed", {
      event: "projects.list_failed",
      err_type: error instanceof Error ? error.name : typeof error,
      ...(error instanceof OpenHandsError && error.status !== undefined ? { status: error.status } : {}),
    });
    return { status: "unavailable" };
  }

  /** Keeps only absolute paths that are exactly one valid segment below the root. */
  private fromPaths(paths: readonly string[]): ProjectEntry[] {
    const prefix = `${this.root}/`;
    const entries: ProjectEntry[] = [];
    for (const raw of paths) {
      const path = raw.replace(/\/+$/, "");
      if (!path.startsWith(prefix)) {
        continue;
      }
      const key = path.slice(prefix.length);
      const entry: ProjectEntry = { key, workingDir: path };
      if (isValidKeyShape(key) && !isDotSegment(key) && isDirectChildOfRoot(this.root, entry)) {
        entries.push(entry);
      }
    }
    return dedupe(entries);
  }
}

function dedupe(entries: readonly ProjectEntry[]): ProjectEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.key) ? false : (seen.add(entry.key), true)));
}

export interface SelectProjectDeps {
  readonly registry: Pick<ProjectRegistry, "resolve">;
  readonly chatState: Pick<ChatStateRepository, "setActiveProject">;
  readonly bindings: Pick<ConversationBindingRepository, "findActive">;
}

export type SelectProjectResult =
  | { readonly status: "selected"; readonly project: ProjectEntry; readonly conversation: "resumed" | "none" }
  | { readonly status: "not_found" }
  | { readonly status: "no_source" }
  | { readonly status: "unavailable" };

/**
 * `SelectProject` intent: validates the key, sets `chat_state.active_project` and reports whether
 * an active conversation binding exists. It never creates a binding or a conversation.
 */
export async function selectProject(
  deps: SelectProjectDeps,
  target: { readonly channel: string; readonly externalChatId: string; readonly key: string },
): Promise<SelectProjectResult> {
  const resolved = await deps.registry.resolve(target.key);
  if (resolved.status !== "found") {
    return resolved;
  }
  const { project } = resolved;
  deps.chatState.setActiveProject(target.channel, target.externalChatId, project.key);
  const binding = deps.bindings.findActive(target.channel, target.externalChatId, project.key);
  return { status: "selected", project, conversation: binding === null ? "none" : "resumed" };
}
