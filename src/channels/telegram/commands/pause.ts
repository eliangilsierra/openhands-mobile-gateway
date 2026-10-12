import type { Bot, Context } from "grammy";
import { pauseTask, type SessionControlDeps } from "../../../core/session.js";
import type { Logger } from "../../../logger.js";
import { ERROR_TEXT, logHandlerError } from "./projects.js";
import { TELEGRAM_CHANNEL } from "./start.js";
import { replyForFailure } from "./status.js";

export const PAUSED_TEXT = "⏸️ Tarea en pausa. Usa /resume para continuar.";

export function registerPause(bot: Bot<Context>, deps: SessionControlDeps, logger?: Logger): void {
  bot.command("pause", async (ctx) => {
    try {
      const result = await pauseTask(deps, { channel: TELEGRAM_CHANNEL, externalChatId: ctx.chat.id.toString() });
      await ctx.reply(result.status === "ok" ? PAUSED_TEXT : replyForFailure(result));
    } catch (error) {
      logHandlerError(logger, "telegram.pause_failed", error);
      await ctx.reply(ERROR_TEXT);
    }
  });
}
