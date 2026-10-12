import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALWAYS_CONFIRM_POLICY,
  CALLBACK_DATA_MAX_BYTES,
  ConfirmationService,
  confirmationPromptText,
  decodeCallbackData,
  encodeCallbackData,
  type ConfirmationClient,
} from "../../src/core/confirmations.js";
import { NotFoundError, UnavailableError } from "../../src/openhands/errors.js";
import { createOpenHandsRestClient } from "../../src/openhands/rest.js";
import { closeStore, openStore } from "../../src/store/db.js";
import { PendingConfirmationRepository } from "../../src/store/pending-confirmation.js";
import { startMockOpenHandsServer, type MockOpenHandsServer } from "../mocks/openhands-server.js";
import { createRecordingLogger, createTempDbPath, type RecordingLogger } from "../store/helpers.js";

const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const ACTION = "99999999-aaaa-bbbb-cccc-dddddddddddd";
const CHAT = "1001";

let db: DatabaseSync;
let cleanup: () => void;
let logger: RecordingLogger;
let store: PendingConfirmationRepository;
let clock: Date;

beforeEach(() => {
  const temp = createTempDbPath();
  cleanup = temp.cleanup;
  logger = createRecordingLogger();
  clock = new Date("2026-01-01T00:00:00.000Z");
  db = openStore({ databasePath: temp.path, logger });
  store = new PendingConfirmationRepository(db, logger, () => clock);
});
afterEach(() => {
  closeStore(db);
  cleanup();
});

function fakeClient(): ConfirmationClient & {
  respond: ReturnType<typeof vi.fn>;
  policy: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn().mockResolvedValue({ success: true });
  const policy = vi.fn().mockResolvedValue({ success: true });
  return { respond, policy, respondToConfirmation: respond, setConfirmationPolicy: policy };
}

function service(client: ConfirmationClient, ttlSeconds?: number): ConfirmationService {
  return new ConfirmationService({
    store,
    client,
    logger,
    now: () => clock,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
}

async function sentRow(svc: ConfirmationService): Promise<number> {
  const result = await svc.request(
    { conversationId: CONVERSATION, actionEventId: ACTION, channel: "telegram", externalChatId: CHAT },
    () => Promise.resolve("77"),
  );
  if (result.status !== "sent") throw new Error("expected sent");
  return result.id;
}

const answerArgs = (id: number, decision: "allow" | "deny" = "allow", chat = CHAT) => ({
  id,
  decision,
  channel: "telegram",
  externalChatId: chat,
  channelMessageId: "77",
});

describe("callback_data codec (T-AC-4)", () => {
  it("encodes only the numeric id and a decision flag, within 64 bytes", () => {
    const data = encodeCallbackData(Number.MAX_SAFE_INTEGER, "deny");
    expect(data).toBe("c:9007199254740991:d");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    expect(data).not.toContain(CONVERSATION);
    expect(encodeCallbackData(12, "allow")).toBe("c:12:a");
  });

  it("round-trips", () => {
    expect(decodeCallbackData(encodeCallbackData(5, "allow"))).toEqual({ id: 5, decision: "allow" });
    expect(decodeCallbackData(encodeCallbackData(5, "deny"))).toEqual({ id: 5, decision: "deny" });
  });

  it.each([
    "",
    "c:",
    "c:1",
    "c:0:a",
    "c:-1:a",
    "c:01:a",
    "c:1:x",
    "c:1:a ",
    "c:1:a:b",
    "x:1:a",
    "c:1.5:a",
    "c:1e3:a",
    `c:${"9".repeat(40)}:a`,
    "c:9999999999999999:a",
    `c:1:a${"a".repeat(80)}`,
    `c:${CONVERSATION}:a`,
  ])("rejects forged data %j", (data) => {
    expect(decodeCallbackData(data)).toBeNull();
  });

  it("refuses to encode an invalid id", () => {
    expect(() => encodeCallbackData(0, "allow")).toThrow(RangeError);
    expect(() => encodeCallbackData(1.5, "allow")).toThrow(RangeError);
  });
});

describe("policy", () => {
  it("sets the AlwaysConfirm policy body", async () => {
    const client = fakeClient();
    await service(client).enablePolicy(CONVERSATION);
    expect(client.policy).toHaveBeenCalledWith(CONVERSATION, ALWAYS_CONFIRM_POLICY);
    expect(ALWAYS_CONFIRM_POLICY).toEqual({ policy: { kind: "AlwaysConfirm" } });
  });
});

describe("request", () => {
  it("creates the row, sends, and binds the message id", async () => {
    const svc = service(fakeClient());
    const id = await sentRow(svc);
    expect(store.findById(id)).toMatchObject({
      conversationId: CONVERSATION,
      actionEventId: ACTION,
      channel: "telegram",
      externalChatId: CHAT,
      channelMessageId: "77",
      resolvedAt: null,
    });
  });

  it("does not send a second prompt for a replayed action event", async () => {
    const svc = service(fakeClient());
    const id = await sentRow(svc);
    const send = vi.fn().mockResolvedValue("78");
    const again = await svc.request(
      { conversationId: CONVERSATION, actionEventId: ACTION, channel: "telegram", externalChatId: CHAT },
      send,
    );
    expect(again).toEqual({ status: "duplicate", id });
    expect(send).not.toHaveBeenCalled();
  });

  it("closes the row when the prompt cannot be sent", async () => {
    const svc = service(fakeClient());
    const result = await svc.request(
      { conversationId: CONVERSATION, actionEventId: ACTION, channel: "telegram", externalChatId: CHAT },
      () => Promise.reject(new Error("telegram down")),
    );
    expect(result).toEqual({ status: "send_failed" });
    const row = store.findByAction(CONVERSATION, ACTION);
    expect(row?.decision).toBe("send_failed");
    expect(row?.resolvedAt).not.toBeNull();
  });
});

describe("answer", () => {
  it("allow calls respond_to_confirmation with accept: true (T-AC-1)", async () => {
    const client = fakeClient();
    const svc = service(client);
    const id = await sentRow(svc);
    expect(await svc.answer(answerArgs(id, "allow"))).toEqual({ status: "answered", decision: "allow" });
    expect(client.respond).toHaveBeenCalledExactlyOnceWith(CONVERSATION, {
      accept: true,
      reason: "telegram user decision",
    });
    expect(store.findById(id)).toMatchObject({ decision: "allow" });
  });

  it("deny calls it with accept: false", async () => {
    const client = fakeClient();
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id, "deny"))).status).toBe("answered");
    expect(client.respond).toHaveBeenCalledWith(CONVERSATION, expect.objectContaining({ accept: false }));
  });

  it("ignores a replayed answer (T-AC-2)", async () => {
    const client = fakeClient();
    const svc = service(client);
    const id = await sentRow(svc);
    await svc.answer(answerArgs(id, "allow"));
    expect((await svc.answer(answerArgs(id, "deny"))).status).toBe("already_resolved");
    expect((await svc.answer(answerArgs(id, "allow"))).status).toBe("already_resolved");
    expect(client.respond).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent taps through", async () => {
    let release: () => void = () => undefined;
    const client = fakeClient();
    client.respond.mockImplementation(() => new Promise((resolve) => (release = () => resolve({}))));
    const svc = service(client);
    const id = await sentRow(svc);
    const first = svc.answer(answerArgs(id, "allow"));
    const second = await svc.answer(answerArgs(id, "allow"));
    expect(second.status).toBe("already_resolved");
    release();
    expect((await first).status).toBe("answered");
    expect(client.respond).toHaveBeenCalledTimes(1);
  });

  it("rejects a tap from another chat without acting (T-AC-3)", async () => {
    const client = fakeClient();
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id, "allow", "2002"))).status).toBe("wrong_chat");
    expect((await svc.answer({ ...answerArgs(id), channel: "slack" })).status).toBe("wrong_chat");
    expect(client.respond).not.toHaveBeenCalled();
    expect(store.findById(id)?.resolvedAt).toBeNull();
  });

  it("rejects a tap on a different message than the prompt", async () => {
    const client = fakeClient();
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer({ ...answerArgs(id), channelMessageId: "999" })).status).toBe("wrong_chat");
    expect(client.respond).not.toHaveBeenCalled();
  });

  it("reports an unknown id", async () => {
    const client = fakeClient();
    expect((await service(client).answer(answerArgs(4242))).status).toBe("not_found");
    expect(client.respond).not.toHaveBeenCalled();
  });

  it("expires after the TTL without calling OpenHands (T-AC-5)", async () => {
    const client = fakeClient();
    const svc = service(client, 3600);
    const id = await sentRow(svc);
    clock = new Date(clock.getTime() + 3600 * 1000);
    expect((await svc.answer(answerArgs(id))).status).toBe("expired");
    expect(client.respond).not.toHaveBeenCalled();
    expect(store.findById(id)?.decision).toBe("expired");
  });

  it("still accepts one second before the TTL", async () => {
    const client = fakeClient();
    const svc = service(client, 3600);
    const id = await sentRow(svc);
    clock = new Date(clock.getTime() + 3599 * 1000);
    expect((await svc.answer(answerArgs(id))).status).toBe("answered");
  });

  it("defaults the TTL to 3600 seconds", async () => {
    const client = fakeClient();
    const svc = service(client);
    const id = await sentRow(svc);
    clock = new Date(clock.getTime() + 3601 * 1000);
    expect((await svc.answer(answerArgs(id))).status).toBe("expired");
  });

  it("re-opens the prompt when OpenHands is provably unreachable", async () => {
    const client = fakeClient();
    client.respond.mockRejectedValueOnce(
      new UnavailableError({ method: "POST", route: "/x", status: 503 }),
    );
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id))).status).toBe("failed");
    expect(store.findById(id)?.resolvedAt).toBeNull();
    expect((await svc.answer(answerArgs(id))).status).toBe("answered");
  });

  it("keeps the prompt closed when the outcome is unknown", async () => {
    const client = fakeClient();
    client.respond.mockRejectedValueOnce(new UnavailableError({ method: "POST", route: "/x" }));
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id))).status).toBe("outcome_unknown");
    expect((await svc.answer(answerArgs(id))).status).toBe("already_resolved");
    expect(client.respond).toHaveBeenCalledTimes(1);
  });

  it("closes the prompt when the conversation is gone", async () => {
    const client = fakeClient();
    client.respond.mockRejectedValueOnce(new NotFoundError({ method: "POST", route: "/x", status: 404 }));
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id))).status).toBe("conversation_gone");
    expect(store.findById(id)?.resolvedAt).not.toBeNull();
  });

  it("re-opens on an unexpected error and logs no secrets or ids of the chat", async () => {
    const client = fakeClient();
    client.respond.mockRejectedValueOnce(new Error("boom token=ghp_abcdefghijklmnop"));
    const svc = service(client);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id))).status).toBe("failed");
    expect(store.findById(id)?.resolvedAt).toBeNull();
    const logged = JSON.stringify(logger.records);
    expect(logged).not.toContain("ghp_");
    expect(logged).not.toContain("boom");
  });
});

describe("store", () => {
  it("is safe against SQL injection through ids", () => {
    expect(store.findByAction("x' OR '1'='1", "y")).toBeNull();
    expect(store.reopen(1, "' OR 1=1 --")).toBe(false);
  });

  it("reopen only affects a row resolved with that exact decision", async () => {
    const id = await sentRow(service(fakeClient()));
    store.resolve(id, "deny");
    expect(store.reopen(id, "allow")).toBe(false);
    expect(store.reopen(id, "deny")).toBe(true);
    expect(store.findById(id)?.resolvedAt).toBeNull();
  });
});

describe("prompt text", () => {
  const base = { id: "e", timestamp: "t", source: "agent", kind: "ActionEvent" };
  it("prefers the summary and strips secrets", () => {
    const text = confirmationPromptText({ ...base, summary: "edit config", tool_name: "bash" });
    expect(text).toContain("edit config");
    expect(confirmationPromptText({ ...base, tool_name: "bash" })).toContain("bash");
    expect(confirmationPromptText({ ...base, summary: "use api_key=abc123def456" })).not.toContain("abc123def456");
  });
  it("falls back to a generic text", () => {
    expect(confirmationPromptText(base)).toContain("confirmación");
  });
});

describe("integration with the mock OpenHands server", () => {
  let server: MockOpenHandsServer;
  beforeAll(async () => {
    server = await startMockOpenHandsServer("k");
  });
  afterAll(async () => {
    await server.close();
  });

  it("sets the policy, then responds to the confirmation", async () => {
    server.requests.length = 0;
    const client = createOpenHandsRestClient({ baseUrl: server.baseUrl, apiKey: "k", retry: { maxAttempts: 1 } });
    const svc = service(client);
    await svc.enablePolicy(CONVERSATION);
    const id = await sentRow(svc);
    expect((await svc.answer(answerArgs(id, "allow"))).status).toBe("answered");
    const posts = server.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.path)).toEqual([
      `/api/conversations/${CONVERSATION}/confirmation_policy`,
      `/api/conversations/${CONVERSATION}/events/respond_to_confirmation`,
    ]);
    expect(posts[0]?.body).toEqual({ policy: { kind: "AlwaysConfirm" } });
    expect(posts[1]?.body).toEqual({ accept: true, reason: "telegram user decision" });
  });
});
