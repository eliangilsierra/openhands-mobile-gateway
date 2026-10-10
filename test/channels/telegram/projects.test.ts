import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Update } from "grammy/types";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerProjects } from "../../../src/channels/telegram/commands/projects.js";
import { NOT_FOUND_TEXT, registerUse } from "../../../src/channels/telegram/commands/use.js";
import { ProjectRegistry } from "../../../src/core/projects.js";
import { createOpenHandsRestClient } from "../../../src/openhands/rest.js";
import { ChatStateRepository } from "../../../src/store/chat-state.js";
import { ConversationBindingRepository } from "../../../src/store/conversation-binding.js";
import { closeStore, openStore } from "../../../src/store/db.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../../mocks/openhands-server.js";
import { createRecordingLogger, createTempDbPath } from "../../store/helpers.js";
import { BOT_INFO, installFakeApi, messageUpdate, type ApiCall } from "./helpers.js";

const USER = 1001;
const CHAT = String(USER);

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

function build(staticProjects: readonly string[] | null) {
  const registry = new ProjectRegistry({
    projectsRoot: "/projects",
    staticProjects,
    client: createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } }),
  });
  const bot = new Bot<Context>("123456:TEST-TOKEN-NOT-REAL");
  // `BOT_INFO` (shared helper, fixed under Issue #37) lacks fields newer grammY versions require.
  bot.botInfo = {
    ...BOT_INFO,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls = installFakeApi(bot, () => ({ ok: true, result: true }));
  registerProjects(bot, registry);
  registerUse(bot, { registry, chatState, bindings });
  return { bot, calls };
}

const replies = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === "sendMessage").map((c) => c.payload["text"] as string);

describe("/projects and /use", () => {
  it("T-AC-1: lists two projects then selects one", async () => {
    const { bot, calls } = build(["toneprofiler", "code-sentinel"]);
    await bot.handleUpdate(messageUpdate(1, USER, "/projects"));

    const list = calls.find((c) => c.method === "sendMessage");
    expect(list?.payload["text"]).toBe("Proyectos disponibles:\n1. toneprofiler\n2. code-sentinel");
    const markup = list?.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      "use:toneprofiler",
      "use:code-sentinel",
    ]);

    await bot.handleUpdate(messageUpdate(2, USER, "/use toneprofiler"));
    expect(chatState.getActiveProject("telegram", CHAT)).toBe("toneprofiler");
    expect(replies(calls)[1]).toContain("Aún no hay conversación");
    expect(bindings.findActive("telegram", CHAT, "toneprofiler")).toBeNull();
  });

  it("limits the keyboard to 8 buttons while the list shows all", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const { bot, calls } = build(names);
    await bot.handleUpdate(messageUpdate(1, USER, "/projects"));
    const payload = calls[0]?.payload;
    expect((payload?.["text"] as string).split("\n")).toHaveLength(11);
    const markup = payload?.["reply_markup"] as { inline_keyboard: unknown[][] };
    expect(markup.inline_keyboard.flat()).toHaveLength(8);
  });

  it("reports a resumed conversation when an active binding exists", async () => {
    bindings.create({
      channel: "telegram",
      externalChatId: CHAT,
      projectKey: "toneprofiler",
      workingDir: "/projects/toneprofiler",
      conversationId: "c-1",
    });
    const { bot, calls } = build(["toneprofiler"]);
    await bot.handleUpdate(messageUpdate(1, USER, "/use toneprofiler"));
    expect(replies(calls)[0]).toContain("reanuda");
  });

  it("T-AC-2: hostile keys get the generic reply, no path, no state change", async () => {
    const { bot, calls } = build(["toneprofiler"]);
    const keys = ["../../home/openhands/.claude", "%2e%2e", "/etc/passwd", "nope"];
    for (const [i, key] of keys.entries()) {
      await bot.handleUpdate(messageUpdate(i + 1, USER, `/use ${key}`));
    }
    expect(replies(calls)).toEqual(keys.map(() => NOT_FOUND_TEXT));
    expect(JSON.stringify(calls)).not.toContain("/projects/");
    expect(chatState.getActiveProject("telegram", CHAT)).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("answers /use without an argument with usage", async () => {
    const { bot, calls } = build(["a"]);
    await bot.handleUpdate(messageUpdate(1, USER, "/use"));
    expect(replies(calls)[0]).toMatch(/^Uso: \/use/);
  });

  it("T-AC-4: static PROJECTS never calls search_subdirs", async () => {
    const { bot } = build(["alpha"]);
    await bot.handleUpdate(messageUpdate(1, USER, "/projects"));
    expect(server.requests).toHaveLength(0);
  });

  it("T-AC-3: 404 on search_subdirs falls back to /api/workspaces", async () => {
    server.addRule({ method: "GET", path: "/api/file/search_subdirs", status: 404 });
    const { bot, calls } = build(null);
    await bot.handleUpdate(messageUpdate(1, USER, "/projects"));
    expect(replies(calls)[0]).toBe("Proyectos disponibles:\n1. alpha");
    expect(server.requests.map((r) => r.path)).toEqual(["/api/file/search_subdirs", "/api/workspaces"]);
  });

  it("T-AC-3: tells the user to ask the operator to set PROJECTS when nothing works", async () => {
    server.addRule({ method: "GET", path: "/api/file/search_subdirs", status: 404 });
    server.addRule({ method: "GET", path: "/api/workspaces", status: 404 });
    const { bot, calls } = build(null);
    await bot.handleUpdate(messageUpdate(1, USER, "/projects"));
    expect(replies(calls)[0]).toContain("configure PROJECTS");
  });

  it("selects through an inline button", async () => {
    const { bot, calls } = build(["alpha"]);
    const update: Update = {
      update_id: 1,
      callback_query: {
        id: "cb1",
        chat_instance: "ci",
        from: { id: USER, is_bot: false, first_name: "Tester" },
        data: "use:alpha",
        message: {
          message_id: 5,
          date: 1_700_000_000,
          chat: { id: USER, type: "private", first_name: "Tester" },
        },
      },
    };
    await bot.handleUpdate(update);
    expect(chatState.getActiveProject("telegram", CHAT)).toBe("alpha");
    expect(calls.map((c) => c.method)).toContain("answerCallbackQuery");
  });

  it("rejects a hostile inline-button payload", async () => {
    const { bot, calls } = build(["alpha"]);
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        chat_instance: "ci",
        from: { id: USER, is_bot: false, first_name: "Tester" },
        data: "use:../etc",
        message: {
          message_id: 5,
          date: 1_700_000_000,
          chat: { id: USER, type: "private", first_name: "Tester" },
        },
      },
    });
    expect(replies(calls)).toEqual([NOT_FOUND_TEXT]);
    expect(chatState.getActiveProject("telegram", CHAT)).toBeNull();
  });
});
