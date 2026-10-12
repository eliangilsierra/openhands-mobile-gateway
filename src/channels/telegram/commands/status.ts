import type { Bot, Context } from "grammy";
import {
  getStatus,
  type ExecutionStatus,
  type SessionControlDeps,
  type SessionControlFailure,
} from "../../../core/session.js";
import type { Logger } from "../../../logger.js";
import { ERROR_TEXT, UNAVAILABLE_TEXT, logHandlerError } from "./projects.js";
import { TELEGRAM_CHANNEL } from "./start.js";

export const NO_BINDING_TEXT =
  "⚠️ No hay una tarea activa en este chat. Elige un proyecto con /use y envía un mensaje.";
export const GONE_TEXT = "⚠️ La conversación ya no existe en OpenHands. Envía un mensaje para crear una nueva.";
export const AUTH_TEXT = "⚠️ La clave de API de OpenHands no es válida. Avisa al operador.";
export const CONFLICT_TEXT = "⏳ La conversación ya se está ejecutando.";
export const OUTCOME_UNKNOWN_TEXT =
  "⚠️ No pude confirmar si OpenHands recibió la orden. Revisa con /status antes de repetirla.";

/** One line per execution status (not runtime status, R2-F14). */
export const STATUS_TEXT: Readonly<Record<ExecutionStatus, string>> = {
  idle: "💤 La conversación está en reposo, esperando una tarea.",
  running: "🏃 El agente está trabajando.",
  paused: "⏸️ La tarea está en pausa. Usa /resume para continuar.",
  waiting_for_confirmation: "⏳ Esperando tu confirmación.",
  finished: "✅ La tarea terminó.",
  error: "💥 La tarea falló",
  stuck: "🧱 El agente está atascado",
  unknown: "❓ No pude determinar el estado de ejecución.",
};

/** Shared failure replies for the four session commands. */
export function replyForFailure(result: SessionControlFailure): string {
  switch (result.status) {
    case "no_active_binding":
      return NO_BINDING_TEXT;
    case "conversation_gone":
      return GONE_TEXT;
    case "unavailable":
      return UNAVAILABLE_TEXT;
    case "outcome_unknown":
      return OUTCOME_UNKNOWN_TEXT;
    case "auth_error":
      return AUTH_TEXT;
    case "already_running":
      return CONFLICT_TEXT;
    case "error":
      return ERROR_TEXT;
  }
}

/** Register after the allowlist middleware so unauthorised senders never reach the session code. */
export function registerStatus(bot: Bot<Context>, deps: SessionControlDeps, logger?: Logger): void {
  bot.command("status", async (ctx) => {
    try {
      const result = await getStatus(deps, { channel: TELEGRAM_CHANNEL, externalChatId: ctx.chat.id.toString() });
      await ctx.reply(result.status === "ok" ? STATUS_TEXT[result.executionStatus] : replyForFailure(result));
    } catch (error) {
      logHandlerError(logger, "telegram.status_failed", error);
      await ctx.reply(ERROR_TEXT);
    }
  });
}
