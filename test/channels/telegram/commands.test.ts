import { Bot } from "grammy";
import type { Context } from "grammy";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerPause, PAUSED_TEXT } from "../../../src/channels/telegram/commands/pause.js";
import { registerResume, RESUMED_TEXT } from "../../../src/channels/telegram/commands/resume.js";
import {
  GONE_TEXT,
  NO_BINDING_TEXT,
  STATUS_TEXT,
  registerStatus,
} from "../../../src/channels/telegram/commands/status.js";
import { registerStop, STOPPED_TEXT } from "../../../src/channels/telegram/commands/stop.js";
import { allowlistMiddleware } from "../../../src/channels/telegram/middleware/allowlist.js";
import type { SessionControlDeps } from "../../../src/core/session.js";
import { createOpenHandsRestClient } from "../../../src/openhands/rest.js";
import { ChatStateRepository } from "../../../src/store/chat-state.js";
import { ConversationBindingRepository } from "../../../src/store/conversation-binding.js";
import { closeStore, openStore } from "../../../src/store/db.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../../mocks/openhands-server.js";
import { createRecordingLogger, createTempDbPath } from "../../store/helpers.js";
import { BOT_INFO, installFakeApi, messageUpdate, type ApiCall } from "./helpers.js";

const USER = 1001;
const STRANGER = 2002;
const CHAT = String(USER);
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
const CONV_PATH = `/api/conversations/${CONVERSATION_ID}`;

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

function build() {
  const client = createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } });
  const deps: SessionControlDeps = { chatState, bindings, client };
  const bot = new Bot<Context>("123456:TEST-TOKEN-NOT-REAL");
  bot.botInfo = {
    ...BOT_INFO,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls = installFakeApi(bot, () => ({ ok: true, result: true }));
  bot.use(allowlistMiddleware({ allowedUserIds: new Set([USER]), logger: createRecordingLogger() }));
  registerStatus(bot, deps);
  registerPause(bot, deps);
  registerResume(bot, deps);
  registerStop(bot, deps);
  return { bot, calls };
}

const replies = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === "sendMessage").map((c) => c.payload["text"] as string);

function bind(): void {
  chatState.setActiveProject("telegram", CHAT, "alpha");
  bindings.create({
    channel: "telegram",
    externalChatId: CHAT,
    projectKey: "alpha",
    workingDir: "/projects/alpha",
    conversationId: CONVERSATION_ID,
  });
}

describe("session commands", () => {
  it("T-AC-1: /pause then /resume call pause and run and confirm", async () => {
    bind();
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "/pause"));
    await bot.handleUpdate(messageUpdate(2, USER, "/resume"));
    expect(replies(calls)).toEqual([PAUSED_TEXT, RESUMED_TEXT]);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${CONV_PATH}/pause`,
      `POST ${CONV_PATH}/run`,
    ]);
  });

  it("T-AC-2: /stop interrupts, says history is preserved and deletes nothing", async () => {
    bind();
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "/stop"));
    expect(replies(calls)).toEqual([STOPPED_TEXT]);
    expect(STOPPED_TEXT).toContain("historial se conserva");
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${CONV_PATH}/interrupt`]);
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(bindings.findActive("telegram", CHAT, "alpha")?.state).toBe("active");
  });

  it.each(["waiting_for_confirmation", "error", "stuck", "running"] as const)(
    "T-AC-3: /status reflects %s specifically",
    async (raw) => {
      bind();
      server.addRule({ method: "GET", path: CONV_PATH, status: 200, body: { id: CONVERSATION_ID, execution_status: raw } });
      const { bot, calls } = build();
      await bot.handleUpdate(messageUpdate(1, USER, "/status"));
      expect(replies(calls)).toEqual([STATUS_TEXT[raw]]);
    },
  );

  it("T-AC-3: /status distinguishes error and stuck from each other and from running", () => {
    expect(new Set([STATUS_TEXT.error, STATUS_TEXT.stuck, STATUS_TEXT.running]).size).toBe(3);
    expect(STATUS_TEXT.error).toBe("💥 La tarea falló");
    expect(STATUS_TEXT.stuck).toBe("🧱 El agente está atascado");
  });

  it.each(["/status", "/pause", "/resume", "/stop"])("T-AC-4: %s without a binding calls nothing", async (command) => {
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, command));
    expect(replies(calls)).toEqual([NO_BINDING_TEXT]);
    chatState.setActiveProject("telegram", CHAT, "alpha");
    await bot.handleUpdate(messageUpdate(2, USER, command));
    expect(replies(calls)).toEqual([NO_BINDING_TEXT, NO_BINDING_TEXT]);
    expect(server.requests).toHaveLength(0);
  });

  it("reports a conversation that vanished upstream", async () => {
    bind();
    server.addRule({ method: "POST", path: `${CONV_PATH}/pause`, status: 404, times: 1 });
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "/pause"));
    expect(replies(calls)).toEqual([GONE_TEXT]);
  });

  it("replies with the generic error when the OpenHands API fails", async () => {
    bind();
    server.addRule({ method: "POST", path: `${CONV_PATH}/run`, status: 409, times: 1 });
    server.addRule({ method: "POST", path: `${CONV_PATH}/pause`, status: 503, times: 1 });
    const { bot, calls } = build();
    await bot.handleUpdate(messageUpdate(1, USER, "/resume"));
    await bot.handleUpdate(messageUpdate(2, USER, "/pause"));
    const texts = replies(calls);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("ya se está ejecutando");
    expect(texts[1]).toContain("no está disponible");
  });

  it.each(["/status", "/pause", "/resume", "/stop"])(
    "rejects %s from a user outside the allowlist (no OpenHands call)",
    async (command) => {
      bind();
      const { bot, calls } = build();
      await bot.handleUpdate(messageUpdate(1, STRANGER, command));
      expect(replies(calls)).toEqual(["⛔ Unauthorized"]);
      expect(server.requests).toHaveLength(0);
    },
  );
});
