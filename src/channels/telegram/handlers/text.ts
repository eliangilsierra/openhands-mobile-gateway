import type { Bot, Context } from "grammy";
import { submitTask, type SubmitTaskDeps, type SubmitTaskResult } from "../../../core/session.js";
import type { Logger } from "../../../logger.js";
import { ERROR_TEXT, NO_SOURCE_TEXT, UNAVAILABLE_TEXT, logHandlerError } from "../commands/projects.js";
import { TELEGRAM_CHANNEL } from "../commands/start.js";

export const ACK_TEXT = "📥 Recibido. Enviando tu tarea a OpenHands…";
export const NO_PROJECT_TEXT = "⚠️ Primero elige un proyecto con /use <proyecto> (usa /projects para ver la lista).";
export const EMPTY_TEXT = "⚠️ El mensaje está vacío.";
export const PROJECT_GONE_TEXT = "⚠️ El proyecto activo ya no existe. Elige otro con /use.";
export const AUTH_TEXT = "⚠️ La clave de API de OpenHands no es válida. Avisa al operador.";
export const RUNNING_TEXT = "⏳ OpenHands ya está ejecutando una tarea en esta conversación.";
export const RECREATED_TEXT =
  "⚠️ La conversación anterior ya no existe en OpenHands; se perdió el historial. Se creó una nueva con tu mensaje.";

export function tooLongText(max: number): string {
  return `⚠️ El mensaje es demasiado largo (máximo ${String(max)} caracteres).`;
}

/** The follow-up reply for a result, or `null` when the acknowledgement already said it all. */
export function replyForResult(result: SubmitTaskResult): string | null {
  switch (result.status) {
    case "created":
    case "sent":
      return null;
    case "recreated":
      return RECREATED_TEXT;
    case "invalid_text":
      return result.reason === "empty" ? EMPTY_TEXT : tooLongText(result.max);
    case "no_active_project":
      return NO_PROJECT_TEXT;
    case "project_not_found":
      return PROJECT_GONE_TEXT;
    case "no_source":
      return NO_SOURCE_TEXT;
    case "unavailable":
      return UNAVAILABLE_TEXT;
    case "auth_error":
      return AUTH_TEXT;
    case "already_running":
      return RUNNING_TEXT;
    case "error":
      return ERROR_TEXT;
  }
}

/**
 * Plain (non-command) text becomes a task (`SendTask` intent). Must be registered after the
 * allowlist middleware so text from unauthorised senders never reaches the session code.
 */
export function registerText(bot: Bot<Context>, deps: SubmitTaskDeps, logger?: Logger): void {
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await next();
      return;
    }
    try {
      const result = await submitTask(
        deps,
        { channel: TELEGRAM_CHANNEL, externalChatId: ctx.chat.id.toString() },
        text,
        async () => {
          await ctx.reply(ACK_TEXT);
        },
      );
      const reply = replyForResult(result);
      if (reply !== null) {
        await ctx.reply(reply);
      }
    } catch (error) {
      logHandlerError(logger, "telegram.text_failed", error);
      await ctx.reply(ERROR_TEXT);
    }
  });
}
