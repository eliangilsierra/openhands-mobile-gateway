import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectRegistry,
  PROJECTS_CACHE_TTL_MS,
  isDirectChildOfRoot,
  isDotSegment,
  isValidKeyShape,
  resolveByMembership,
  selectProject,
  type ProjectEntry,
} from "../../src/core/projects.js";
import { UnexpectedResponseError, UnavailableError } from "../../src/openhands/errors.js";
import type { SubdirsResult, WorkspaceList } from "../../src/openhands/types.js";
import { createOpenHandsRestClient } from "../../src/openhands/rest.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../mocks/openhands-server.js";

const ROOT = "/projects";
const entry = (key: string): ProjectEntry => ({ key, workingDir: `${ROOT}/${key}` });

function fakeClient(overrides: {
  searchSubdirs?: (path: string) => Promise<SubdirsResult>;
  listWorkspaces?: () => Promise<WorkspaceList>;
}) {
  return {
    searchSubdirs: vi.fn(overrides.searchSubdirs ?? (() => Promise.reject(new Error("unexpected call")))),
    listWorkspaces: vi.fn(overrides.listWorkspaces ?? (() => Promise.reject(new Error("unexpected call")))),
  };
}

const status = (code: number) =>
  new UnexpectedResponseError({ method: "GET", route: "/x", status: code });

describe("validation controls", () => {
  it("control 1 accepts plain keys and rejects hostile payloads", () => {
    for (const ok of ["toneprofiler", "code-sentinel", "a", "A1._-x", "a".repeat(64)]) {
      expect(isValidKeyShape(ok)).toBe(true);
    }
    const bad = [
      "",
      "..",
      ".hidden",
      "-lead",
      "../../home/openhands/.claude",
      "%2e%2e",
      "/etc/passwd",
      "~root",
      "a$b",
      "a`b",
      "a\0b",
      "a\nb",
      "a b",
      "a/b",
      "a".repeat(65),
    ];
    for (const key of bad) {
      expect(isValidKeyShape(key), JSON.stringify(key)).toBe(false);
    }
  });

  it("control 2 rejects only the literal dot segments", () => {
    expect(isDotSegment(".")).toBe(true);
    expect(isDotSegment("..")).toBe(true);
    expect(isDotSegment("...")).toBe(false);
    expect(isDotSegment("a")).toBe(false);
  });

  it("control 3 resolves by set membership and never builds a path", () => {
    const entries = [entry("alpha"), entry("beta")];
    expect(resolveByMembership("beta", entries)).toBe(entries[1]);
    expect(resolveByMembership("gamma", entries)).toBeNull();
    expect(resolveByMembership("Alpha", entries)).toBeNull();
  });

  it("control 4 asserts exactly root + one segment", () => {
    expect(isDirectChildOfRoot(ROOT, entry("alpha"))).toBe(true);
    expect(isDirectChildOfRoot("/projects/", entry("alpha"))).toBe(true);
    expect(isDirectChildOfRoot(ROOT, { key: "alpha", workingDir: "/projects/alpha/sub" })).toBe(false);
    expect(isDirectChildOfRoot(ROOT, { key: "alpha", workingDir: "/other/alpha" })).toBe(false);
    expect(isDirectChildOfRoot(ROOT, { key: "alpha", workingDir: "/projects/beta" })).toBe(false);
    expect(isDirectChildOfRoot(ROOT, { key: "..", workingDir: "/projects/.." })).toBe(false);
  });
});

describe("resolution order", () => {
  it("T-AC-4: static PROJECTS is authoritative and OpenHands is never called", async () => {
    const client = fakeClient({});
    const registry = new ProjectRegistry({
      projectsRoot: ROOT,
      staticProjects: ["toneprofiler", "code-sentinel", "../evil", "toneprofiler"],
      client,
    });
    const listed = await registry.list();
    expect(listed).toEqual({ status: "ok", projects: [entry("toneprofiler"), entry("code-sentinel")] });
    expect(client.searchSubdirs).not.toHaveBeenCalled();
    expect(client.listWorkspaces).not.toHaveBeenCalled();
  });

  it("uses search_subdirs with PROJECTS_ROOT and keeps only direct children", async () => {
    const client = fakeClient({
      searchSubdirs: () =>
        Promise.resolve({
          items: ["/projects/alpha", "/projects/beta/", "/projects/a/b", "/etc/passwd", "/projects/..", 7, { path: "/projects/gamma" }],
        }),
    });
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client });
    const listed = await registry.list();
    expect(listed).toEqual({ status: "ok", projects: [entry("alpha"), entry("beta"), entry("gamma")] });
    expect(client.searchSubdirs).toHaveBeenCalledWith(ROOT);
    expect(client.listWorkspaces).not.toHaveBeenCalled();
  });

  it("accepts a bare array payload", async () => {
    const client = fakeClient({ searchSubdirs: () => Promise.resolve(["/projects/alpha"]) });
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client });
    expect(await registry.list()).toEqual({ status: "ok", projects: [entry("alpha")] });
  });

  it.each([404, 501])("falls back to workspaces on %i from search_subdirs", async (code) => {
    const client = fakeClient({
      searchSubdirs: () => Promise.reject(status(code)),
      listWorkspaces: () => Promise.resolve({ items: [{ path: "/projects/alpha" }, { path: "/elsewhere/x" }] }),
    });
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client });
    expect(await registry.list()).toEqual({ status: "ok", projects: [entry("alpha")] });
  });

  it("T-AC-3: reports no_source when search_subdirs 404s and workspaces fails or is empty", async () => {
    const failing = fakeClient({
      searchSubdirs: () => Promise.reject(status(404)),
      listWorkspaces: () => Promise.reject(status(404)),
    });
    expect(await new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client: failing }).list()).toEqual({
      status: "no_source",
    });
    const empty = fakeClient({
      searchSubdirs: () => Promise.reject(status(404)),
      listWorkspaces: () => Promise.resolve({ items: [] }),
    });
    expect(await new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client: empty }).list()).toEqual({
      status: "no_source",
    });
  });

  it("does not fall back on an outage and does not cache the failure", async () => {
    let fail = true;
    const client = fakeClient({
      searchSubdirs: () =>
        fail
          ? Promise.reject(new UnavailableError({ method: "GET", route: "/x", status: 503 }))
          : Promise.resolve(["/projects/alpha"]),
    });
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client });
    expect(await registry.list()).toEqual({ status: "unavailable" });
    expect(client.listWorkspaces).not.toHaveBeenCalled();
    fail = false;
    expect(await registry.list()).toEqual({ status: "ok", projects: [entry("alpha")] });
  });
});

describe("cache", () => {
  it("serves the list for 60 s and refreshes afterwards", async () => {
    let now = 1_000;
    const client = fakeClient({ searchSubdirs: () => Promise.resolve(["/projects/alpha"]) });
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client, now: () => now });
    await registry.list();
    now += PROJECTS_CACHE_TTL_MS - 1;
    await registry.list();
    expect(client.searchSubdirs).toHaveBeenCalledTimes(1);
    now += 1;
    await registry.list();
    expect(client.searchSubdirs).toHaveBeenCalledTimes(2);
  });
});

describe("resolve", () => {
  it("T-AC-2: hostile keys are rejected before any list lookup or network call", async () => {
    const client = fakeClient({});
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client });
    for (const key of ["../../home/openhands/.claude", "%2e%2e", "/etc/passwd", "..", ".", "a\nb"]) {
      expect(await registry.resolve(key)).toEqual({ status: "not_found" });
    }
    expect(client.searchSubdirs).not.toHaveBeenCalled();
    expect(client.listWorkspaces).not.toHaveBeenCalled();
  });

  it("finds a listed key, and reports unknown valid keys as not_found without a path", async () => {
    const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: ["alpha"], client: fakeClient({}) });
    expect(await registry.resolve("alpha")).toEqual({ status: "found", project: entry("alpha") });
    expect(await registry.resolve("beta")).toEqual({ status: "not_found" });
  });

  it("propagates no_source and unavailable", async () => {
    const down = fakeClient({ searchSubdirs: () => Promise.reject(new Error("boom")) });
    expect(await new ProjectRegistry({ projectsRoot: ROOT, staticProjects: null, client: down }).resolve("a")).toEqual({
      status: "unavailable",
    });
  });
});

describe("selectProject", () => {
  const target = { channel: "telegram", externalChatId: "42", key: "alpha" };
  const registry = new ProjectRegistry({ projectsRoot: ROOT, staticProjects: ["alpha"], client: fakeClient({}) });

  it("sets the active project and reports no conversation without creating one", async () => {
    const setActiveProject = vi.fn();
    const findActive = vi.fn(() => null);
    const result = await selectProject(
      { registry, chatState: { setActiveProject }, bindings: { findActive } },
      target,
    );
    expect(result).toEqual({ status: "selected", project: entry("alpha"), conversation: "none" });
    expect(setActiveProject).toHaveBeenCalledWith("telegram", "42", "alpha");
    expect(findActive).toHaveBeenCalledWith("telegram", "42", "alpha");
  });

  it("reports a resumed conversation when an active binding exists", async () => {
    const result = await selectProject(
      {
        registry,
        chatState: { setActiveProject: vi.fn() },
        bindings: { findActive: vi.fn(() => ({}) as never) },
      },
      target,
    );
    expect(result).toMatchObject({ status: "selected", conversation: "resumed" });
  });

  it("does not touch the store for an unknown key", async () => {
    const setActiveProject = vi.fn();
    const result = await selectProject(
      { registry, chatState: { setActiveProject }, bindings: { findActive: vi.fn() } },
      { ...target, key: "nope" },
    );
    expect(result).toEqual({ status: "not_found" });
    expect(setActiveProject).not.toHaveBeenCalled();
  });
});

describe("against the mock OpenHands server", () => {
  let server: MockOpenHandsServer;
  beforeAll(async () => {
    server = await startMockOpenHandsServer("k");
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.clearRules();
    server.requests.length = 0;
  });
  const registry = () =>
    new ProjectRegistry({
      projectsRoot: ROOT,
      staticProjects: null,
      client: createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } }),
    });

  it("lists via search_subdirs", async () => {
    expect(await registry().list()).toEqual({ status: "ok", projects: [entry("alpha"), entry("beta")] });
  });

  it("falls back to workspaces on a real 404", async () => {
    server.addRule({ method: "GET", path: "/api/file/search_subdirs", status: 404 });
    expect(await registry().list()).toEqual({ status: "ok", projects: [entry("alpha")] });
    expect(server.requests.map((r) => r.path)).toEqual(["/api/file/search_subdirs", "/api/workspaces"]);
  });

  it("reports no_source when both endpoints 404", async () => {
    server.addRule({ method: "GET", path: "/api/file/search_subdirs", status: 404 });
    server.addRule({ method: "GET", path: "/api/workspaces", status: 404 });
    expect(await registry().list()).toEqual({ status: "no_source" });
  });
});
