import type { Bot, Context } from "grammy";
import { selectProject, type SelectProjectDeps } from "../../../core/projects.js";
import type { Logger } from "../../../logger.js";
import { ERROR_TEXT, NO_SOURCE_TEXT, UNAVAILABLE_TEXT, USE_CALLBACK_PREFIX, logHandlerError } from "./projects.js";
import { TELEGRAM_CHANNEL } from "./start.js";

export const NOT_FOUND_TEXT = "⚠️ Proyecto no encontrado. Usa /projects para ver la lista.";
export const USAGE_TEXT = "Uso: /use <proyecto>. Usa /projects para ver la lista.";

async function replyFor(ctx: Context, deps: SelectProjectDeps, key: string): Promise<string> {
  const chat = ctx.chat;
  if (chat === undefined) {
    return NOT_FOUND_TEXT;
  }
  const result = await selectProject(deps, {
    channel: TELEGRAM_CHANNEL,
    externalChatId: chat.id.toString(),
    key,
  });
  switch (result.status) {
    case "selected":
      return result.conversation === "resumed"
        ? `✅ Proyecto activo: ${result.project.key}. Se reanuda la conversación existente.`
        : `✅ Proyecto activo: ${result.project.key}. Aún no hay conversación; se creará con tu próximo mensaje.`;
    case "not_found":
      return NOT_FOUND_TEXT;
    case "no_source":
      return NO_SOURCE_TEXT;
    case "unavailable":
      return UNAVAILABLE_TEXT;
  }
}

async function safeReplyFor(
  ctx: Context,
  deps: SelectProjectDeps,
  key: string,
  logger: Logger | undefined,
): Promise<string> {
  try {
    return await replyFor(ctx, deps, key);
  } catch (error) {
    logHandlerError(logger, "telegram.use_failed", error);
    return ERROR_TEXT;
  }
}

/** `/use <key>` and the `/projects` inline buttons (`SelectProject` intent). */
export function registerUse(bot: Bot<Context>, deps: SelectProjectDeps, logger?: Logger): void {
  bot.command("use", async (ctx) => {
    const key = ctx.match.trim();
    if (key.length === 0) {
      await ctx.reply(USAGE_TEXT);
      return;
    }
    await ctx.reply(await safeReplyFor(ctx, deps, key, logger));
  });

  bot.callbackQuery(new RegExp(`^${USE_CALLBACK_PREFIX}(.+)$`, "s"), async (ctx) => {
    const key = ctx.match[1] ?? "";
    await ctx.answerCallbackQuery();
    const text = await safeReplyFor(ctx, deps, key, logger);
    await ctx.reply(text);
  });
}
