import type { Bot, Context } from "grammy";
import { stopTask, type SessionControlDeps } from "../../../core/session.js";
import type { Logger } from "../../../logger.js";
import { ERROR_TEXT, logHandlerError } from "./projects.js";
import { TELEGRAM_CHANNEL } from "./start.js";
import { replyForFailure } from "./status.js";

export const STOPPED_TEXT =
  "🛑 Ejecución detenida. La conversación no se elimina: el historial se conserva y puedes continuar después con /resume o un mensaje nuevo.";

export function registerStop(bot: Bot<Context>, deps: SessionControlDeps, logger?: Logger): void {
  bot.command("stop", async (ctx) => {
    try {
      const result = await stopTask(deps, { channel: TELEGRAM_CHANNEL, externalChatId: ctx.chat.id.toString() });
      await ctx.reply(result.status === "ok" ? STOPPED_TEXT : replyForFailure(result));
    } catch (error) {
      logHandlerError(logger, "telegram.stop_failed", error);
      await ctx.reply(ERROR_TEXT);
    }
  });
}
