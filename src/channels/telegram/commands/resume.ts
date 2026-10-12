import type { Bot, Context } from "grammy";
import { resumeTask, type SessionControlDeps } from "../../../core/session.js";
import type { Logger } from "../../../logger.js";
import { ERROR_TEXT, logHandlerError } from "./projects.js";
import { TELEGRAM_CHANNEL } from "./start.js";
import { replyForFailure } from "./status.js";

export const RESUMED_TEXT = "▶️ Se reanuda la tarea.";

export function registerResume(bot: Bot<Context>, deps: SessionControlDeps, logger?: Logger): void {
  bot.command("resume", async (ctx) => {
    try {
      const result = await resumeTask(deps, { channel: TELEGRAM_CHANNEL, externalChatId: ctx.chat.id.toString() });
      await ctx.reply(result.status === "ok" ? RESUMED_TEXT : replyForFailure(result));
    } catch (error) {
      logHandlerError(logger, "telegram.resume_failed", error);
      await ctx.reply(ERROR_TEXT);
    }
  });
}
