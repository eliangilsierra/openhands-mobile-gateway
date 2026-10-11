import { Bot } from "grammy";
import type { Context } from "grammy";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { allowlistMiddleware } from "../../../src/channels/telegram/middleware/allowlist.js";
import {
  ACK_TEXT,
  NO_PROJECT_TEXT,
  RECREATED_TEXT,
  registerText,
  tooLongText,
} from "../../../src/channels/telegram/handlers/text.js";
import { ProjectRegistry } from "../../../src/core/projects.js";
import { DEFAULT_MAX_TASK_CHARS, type SubmitTaskDeps } from "../../../src/core/session.js";
import { createOpenHandsRestClient } from "../../../src/openhands/rest.js";
import { ChatStateRepository } from "../../../src/store/chat-state.js";
import { ConversationBindingRepository } from "../../../src/store/conversation-binding.js";
import { closeStore, openStore } from "../../../src/store/db.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../../mocks/openhands-server.js";
import { createRecordingLogger, createTempDbPath } from "../../store/helpers.js";
import { BOT_INFO, installFakeApi, messageUpdate, type ApiCall } from "./helpers.js";

const USER = 1001;
const CHAT = String(USER);
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

let server: MockOpenHandsServer;
let db: DatabaseSync;
let cleanup: () => void;
let chatState: ChatStateRepository;
let bindings: ConversationBindingRepository;

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
  const logger = createRecordingLogger();
  db = openStore({ databasePath: temp.path, logger });
  chatState = new ChatStateRepository(db, logger);
  bindings = new ConversationBindingRepository(db, logger);
});
afterEach(() => {
  closeStore(db);
  cleanup();
});

function build(overrideDeps?: (deps: SubmitTaskDeps) => SubmitTaskDeps) {
  const client = createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } });
  const registry = new ProjectRegistry({ projectsRoot: "/projects", staticProjects: ["alpha"], client });
  const base: SubmitTaskDeps = { registry, chatState, bindings, client };
  const bot = new Bot<Context>("123456:TEST-TOKEN-NOT-REAL");
  bot.botInfo = {
    ...BOT_INFO,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const timeline: string[] = [];
  const calls = installFakeApi(bot, (call) => {
    timeline.push(`telegram:${call.method}`);
    return { ok: true, result: true };
  });
  bot.use(allowlistMiddleware({ allowedUserIds: new Set([USER]), logger: createRecordingLogger() }));
  registerText(bot, overrideDeps ? overrideDeps(base) : base);
  return { bot, calls, timeline };
}

const replies = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === "sendMessage").map((c) => c.payload["text"] as string);

describe("free-text handler", () => {
  it("acks, then creates the conversation (ack precedes every OpenHands request)", async () => {
    chatState.setActiveProject("telegram", CHAT, "alpha");
    const { bot, calls } = build();
    let requestsAtAck = -1;
    const original = bot.api.config.use.bind(bot.api.config);
    original(async (prev, method, payload, signal) => {
      if (method === "sendMessage") {
        requestsAtAck = server.requests.length;
      }
      return prev(method, payload, signal);
    });
    await bot.handleUpdate(messageUpdate(1, USER, "Revisa el último PR y ejecuta tests"));

    expect(replies(calls)).toEqual([ACK_TEXT]);
    expect(requestsAtAck).toBe(0);
    const created = server.requests.filter((r) => r.method === "POST" && r.path === "/api/conversations");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({
      workspace: { working_dir: "/projects/alpha" },
      initial_message: "Revisa el último PR y ejecuta tests",
    });
    expect(bindings.findActive("telegram", CHAT, "alpha")?.conversationId).toBe(CONVERSATION_ID);
  });

  it("sends a follow-up message to the existing conversation", async () => {
    chatState.setActiveProject("telegram", CHAT, "alpha");
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "primero"));
    server.requests.length = 0;
    await bot.handleUpdate(messageUpdate(2, USER, "segundo"));

    expect(replies(calls)).toEqual([ACK_TEXT, ACK_TEXT]);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /api/conversations/${CONVERSATION_ID}/events`,
    ]);
  });

  it("tells the user to pick a project first and calls nothing", async () => {
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "hola"));
    expect(replies(calls)).toEqual([NO_PROJECT_TEXT]);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects over-long text locally", async () => {
    chatState.setActiveProject("telegram", CHAT, "alpha");
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "x".repeat(DEFAULT_MAX_TASK_CHARS + 1)));
    expect(replies(calls)).toEqual([tooLongText(DEFAULT_MAX_TASK_CHARS)]);
    expect(server.requests).toHaveLength(0);
  });

  it("reports lost history after a 404 and a fresh conversation", async () => {
    chatState.setActiveProject("telegram", CHAT, "alpha");
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "primero"));
    server.addRule({ method: "POST", path: `/api/conversations/${CONVERSATION_ID}/events`, status: 404, times: 1 });
    server.addRule({ method: "POST", path: "/api/conversations", status: 201, body: { id: "fresh" }, times: 1 });
    await bot.handleUpdate(messageUpdate(2, USER, "segundo"));
    expect(replies(calls).at(-1)).toBe(RECREATED_TEXT);
    expect(bindings.findActive("telegram", CHAT, "alpha")?.conversationId).toBe("fresh");
  });

  it("never lets text from an unauthorised user reach the session code", async () => {
    chatState.setActiveProject("telegram", "2002", "alpha");
    const find = vi.spyOn(bindings, "findActive");
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, 2002, "ejecuta rm -rf"));
    expect(find).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    expect(replies(calls)).not.toContain(ACK_TEXT);
  });

  it("does not treat commands as tasks", async () => {
    chatState.setActiveProject("telegram", CHAT, "alpha");
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "/unknowncommand algo"));
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });

  it("replies with a generic error and logs only the error type when the session code throws", async () => {
    const throwing = vi.fn(() => {
      throw new Error("secret-detail");
    });
    const { bot, calls } = build((deps) => ({ ...deps, chatState: { getActiveProject: throwing } }));
    await bot.handleUpdate(messageUpdate(1, USER, "hola"));
    expect(replies(calls)).toHaveLength(1);
    expect(replies(calls)[0]).not.toContain("secret-detail");
  });
});
