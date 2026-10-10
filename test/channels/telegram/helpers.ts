import type { Bot, Context } from "grammy";
import type { Update } from "grammy/types";

export interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export type ApiResult = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: { retry_after: number } };

/** Fake Telegram transport: records every call and answers via `respond`; no network. */
export function installFakeApi(
  bot: Bot<Context>,
  respond: (call: ApiCall) => ApiResult | Promise<ApiResult>,
): ApiCall[] {
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const call: ApiCall = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    return (await respond(call)) as never;
  });
  return calls;
}

export const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Gateway",
  username: "gateway_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

export function messageUpdate(updateId: number, userId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: userId, type: "private", first_name: "Tester" },
      from: { id: userId, is_bot: false, first_name: "Tester" },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]?.length ?? 0 }] }
        : {}),
    },
  };
}
