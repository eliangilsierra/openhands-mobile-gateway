import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRegistry } from "../../src/core/projects.js";
import { DEFAULT_MAX_TASK_CHARS, submitTask, type SubmitTaskDeps } from "../../src/core/session.js";
import { AuthError, ConflictError, UnavailableError } from "../../src/openhands/errors.js";
import { createOpenHandsRestClient } from "../../src/openhands/rest.js";
import { ChatStateRepository } from "../../src/store/chat-state.js";
import { ConversationBindingRepository } from "../../src/store/conversation-binding.js";
import { closeStore, openStore } from "../../src/store/db.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../mocks/openhands-server.js";
import { createRecordingLogger, createTempDbPath, type RecordingLogger } from "../store/helpers.js";

const TARGET = { channel: "telegram", externalChatId: "42" } as const;
const TASK = "Revisa el último PR, corrige errores y ejecuta tests";
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

let server: MockOpenHandsServer;
let db: DatabaseSync;
let cleanup: () => void;
let logger: RecordingLogger;
let chatState: ChatStateRepository;
let bindings: ConversationBindingRepository;
let deps: SubmitTaskDeps;

beforeAll(async () => {
  server = await startMockOpenHandsServer("k");
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.clearRules();
  server.requests.length = 0;
  const temp = createTempDbPath();
  cleanup = temp.cleanup;
  logger = createRecordingLogger();
  db = openStore({ databasePath: temp.path, logger });
  chatState = new ChatStateRepository(db, logger);
  bindings = new ConversationBindingRepository(db, logger);
  deps = realDeps();
});
afterEach(() => {
  closeStore(db);
  cleanup();
});

function realDeps(): SubmitTaskDeps {
  const client = createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } });
  const registry = new ProjectRegistry({ projectsRoot: "/projects", staticProjects: ["alpha"], client });
  return { registry, chatState, bindings, client, logger };
}

const noAck = (): Promise<void> => Promise.resolve();
const posts = (path: RegExp | string) =>
  server.requests.filter((r) => r.method === "POST" && (typeof path === "string" ? r.path === path : path.test(r.path)));

describe("submitTask", () => {
  it("T-AC-1: creates a conversation with the resolved working_dir, persists the binding and acks first", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    const seenAtAck: number[] = [];
    const result = await submitTask(deps, TARGET, TASK, () => {
      seenAtAck.push(server.requests.length);
      return Promise.resolve();
    });

    expect(result).toEqual({ status: "created" });
    expect(seenAtAck).toEqual([0]); // ack enqueued before any OpenHands request
    const created = posts("/api/conversations");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({ workspace: { working_dir: "/projects/alpha" }, initial_message: TASK });
    const binding = bindings.findActive("telegram", "42", "alpha");
    expect(binding?.conversationId).toBe(CONVERSATION_ID);
    expect(binding?.workingDir).toBe("/projects/alpha");
  });

  it("T-AC-2: a second message (after a simulated restart) goes to the same conversation", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    await submitTask(deps, TARGET, TASK, noAck);
    server.requests.length = 0;

    const restarted = realDeps(); // fresh registry and client, same database
    const result = await submitTask(restarted, TARGET, "segundo mensaje", noAck);

    expect(result).toEqual({ status: "sent" });
    expect(posts("/api/conversations")).toHaveLength(0);
    const events = posts(`/api/conversations/${CONVERSATION_ID}/events`);
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toEqual({ role: "user", content: "segundo mensaje", run: true });
  });

  it("T-AC-3: without an active project nothing is sent and no ack is made", async () => {
    const ack = vi.fn(noAck);
    expect(await submitTask(deps, TARGET, TASK, ack)).toEqual({ status: "no_active_project" });
    expect(server.requests).toHaveLength(0);
    expect(ack).not.toHaveBeenCalled();
  });

  it("T-AC-4: text above MAX_TASK_CHARS is rejected locally; the limit itself is accepted", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    const ack = vi.fn(noAck);
    const tooLong = await submitTask(deps, TARGET, "x".repeat(DEFAULT_MAX_TASK_CHARS + 1), ack);
    expect(tooLong).toEqual({ status: "invalid_text", reason: "too_long", max: DEFAULT_MAX_TASK_CHARS });
    expect(server.requests).toHaveLength(0);
    expect(ack).not.toHaveBeenCalled();

    expect((await submitTask({ ...deps, maxTaskChars: 5 }, TARGET, "12345", noAck)).status).toBe("created");
  });

  it.each(["", "   \n\t "])("rejects empty text %j before any call", async (text) => {
    chatState.setActiveProject("telegram", "42", "alpha");
    expect(await submitTask(deps, TARGET, text, noAck)).toMatchObject({ status: "invalid_text", reason: "empty" });
    expect(server.requests).toHaveLength(0);
  });

  it("T-AC-5: a 404 marks the binding stale, creates a fresh conversation and reports it", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    await submitTask(deps, TARGET, TASK, noAck);
    server.requests.length = 0;
    server.addRule({ method: "POST", path: `/api/conversations/${CONVERSATION_ID}/events`, status: 404, times: 1 });
    server.addRule({ method: "POST", path: "/api/conversations", status: 201, body: { id: "new-conversation" }, times: 1 });

    const result = await submitTask(deps, TARGET, "sigue", noAck);

    expect(result).toEqual({ status: "recreated" });
    expect(bindings.findByConversationId(CONVERSATION_ID)?.state).toBe("stale");
    expect(bindings.findActive("telegram", "42", "alpha")?.conversationId).toBe("new-conversation");
    expect(posts("/api/conversations")[0]?.body).toEqual({
      workspace: { working_dir: "/projects/alpha" },
      initial_message: "sigue",
    });
  });

  it("acks before the 404 recovery round trips", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    await submitTask(deps, TARGET, TASK, noAck);
    server.requests.length = 0;
    server.addRule({ method: "POST", path: `/api/conversations/${CONVERSATION_ID}/events`, status: 404, times: 1 });
    server.addRule({ method: "POST", path: "/api/conversations", status: 201, body: { id: "other" }, times: 1 });
    let seen = -1;
    await submitTask(deps, TARGET, "sigue", () => {
      seen = server.requests.length;
      return Promise.resolve();
    });
    expect(seen).toBe(0);
  });

  it("a vanished project is reported without creating anything", async () => {
    chatState.setActiveProject("telegram", "42", "gone");
    expect(await submitTask(deps, TARGET, TASK, noAck)).toEqual({ status: "project_not_found" });
    expect(posts("/api/conversations")).toHaveLength(0);
  });

  it("still submits the task when the acknowledgement fails", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    const result = await submitTask(deps, TARGET, TASK, () => Promise.reject(new Error("telegram down")));
    expect(result).toEqual({ status: "created" });
    expect(logger.records.some((r) => r.fields?.["event"] === "session.ack_failed")).toBe(true);
  });

  describe("upstream errors", () => {
    const ctx = { method: "POST", route: "/x" };
    const cases = [
      ["401", new AuthError({ ...ctx, status: 401 }), "auth_error"],
      ["409", new ConflictError({ ...ctx, status: 409 }), "already_running"],
      ["503", new UnavailableError({ ...ctx, status: 503 }), "unavailable"],
      ["other", new TypeError("boom"), "error"],
    ] as const;

    it.each(cases)("maps %s on sendEvent", async (_name, error, expected) => {
      chatState.setActiveProject("telegram", "42", "alpha");
      bindings.create({
        channel: "telegram",
        externalChatId: "42",
        projectKey: "alpha",
        workingDir: "/projects/alpha",
        conversationId: "c1",
      });
      const failing = { ...deps, client: { createConversation: vi.fn(), sendEvent: vi.fn().mockRejectedValue(error) } };
      expect(await submitTask(failing, TARGET, TASK, noAck)).toEqual({ status: expected });
      expect(failing.client.sendEvent).toHaveBeenCalledTimes(1); // never retried
      expect(bindings.findActive("telegram", "42", "alpha")?.state).toBe("active");
    });

    it("maps a 401 on create and logs ERROR without the key or the text", async () => {
      chatState.setActiveProject("telegram", "42", "alpha");
      server.addRule({ method: "POST", path: "/api/conversations", status: 401 });
      expect(await submitTask(deps, TARGET, TASK, noAck)).toEqual({ status: "auth_error" });
      expect(bindings.findActive("telegram", "42", "alpha")).toBeNull();
      const logged = JSON.stringify(logger.records);
      expect(logger.records.some((r) => r.level === "error" && r.fields?.["event"] === "session.auth_failed")).toBe(true);
      expect(logged).not.toContain(TASK);
      expect(logged).not.toContain("/projects");
    });

    it("maps a registry outage to unavailable", async () => {
      chatState.setActiveProject("telegram", "42", "alpha");
      const unavailable = { ...deps, registry: { resolve: () => Promise.resolve({ status: "unavailable" as const }) } };
      expect(await submitTask(unavailable, TARGET, TASK, noAck)).toEqual({ status: "unavailable" });
    });
  });

  it("never logs the task text or paths on success", async () => {
    chatState.setActiveProject("telegram", "42", "alpha");
    await submitTask(deps, TARGET, TASK, noAck);
    const logged = JSON.stringify(logger.records);
    expect(logged).not.toContain(TASK);
    expect(logged).not.toContain("/projects");
  });

  it("module spawns no subprocess and builds no URL or path from the text", () => {
    const source = readFileSync(new URL("../../src/core/session.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|node:fs|node:path|\bexec(Sync)?\(|\bspawn\(/);
    expect(source).not.toMatch(/`[^`]*\$\{text\}[^`]*`/);
  });
});
