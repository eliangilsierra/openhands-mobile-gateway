import { InlineKeyboard } from "grammy";
import type { Api, Bot, Context } from "grammy";
import {
  decodeCallbackData,
  encodeCallbackData,
  type AnswerRequest,
  type AnswerResult,
  type ConfirmationService,
} from "../../../core/confirmations.js";
import type { Logger } from "../../../logger.js";
import { TELEGRAM_CHANNEL } from "../commands/start.js";

export const ALLOW_LABEL = "✅ Permitir";
export const DENY_LABEL = "❌ Denegar";

export const ANSWERED_ALLOW_TEXT = "✅ Permitido";
export const ANSWERED_DENY_TEXT = "❌ Denegado";
export const EXPIRED_TEXT = "Esta confirmación ya expiró";
export const REJECTED_TEXT = "No puedes responder esta confirmación";
export const GONE_TEXT = "La conversación ya no existe en OpenHands";
export const UNKNOWN_OUTCOME_TEXT = "No pude confirmar si OpenHands recibió tu respuesta; revisa el estado";
export const FAILED_TEXT = "No pude enviar tu respuesta a OpenHands; inténtalo de nuevo";
export const ERROR_TEXT = "Ocurrió un error; inténtalo de nuevo";

/** The two-button keyboard of a prompt; `callback_data` carries only `c:<id>:<a|d>`. */
export function buildConfirmationKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(ALLOW_LABEL, encodeCallbackData(id, "allow"))
    .text(DENY_LABEL, encodeCallbackData(id, "deny"));
}

/** A `SendPrompt` for {@link ConfirmationService.request}: sends `text` with the keyboard. */
export function telegramPromptSender(
  api: Pick<Api, "sendMessage">,
  chatId: string,
  text: string,
): (id: number) => Promise<string> {
  return async (id) => {
    const message = await api.sendMessage(chatId, text, { reply_markup: buildConfirmationKeyboard(id) });
    return String(message.message_id);
  };
}

export function toastFor(result: AnswerResult): string {
  switch (result.status) {
    case "answered":
      return result.decision === "allow" ? ANSWERED_ALLOW_TEXT : ANSWERED_DENY_TEXT;
    case "expired":
    case "already_resolved":
    case "not_found":
      return EXPIRED_TEXT;
    case "wrong_chat":
      return REJECTED_TEXT;
    case "conversation_gone":
      return GONE_TEXT;
    case "outcome_unknown":
      return UNKNOWN_OUTCOME_TEXT;
    case "failed":
      return FAILED_TEXT;
  }
}

/** Statuses after which the prompt is closed, so its keyboard must go. */
function closesPrompt(result: AnswerResult): boolean {
  return result.status !== "wrong_chat" && result.status !== "failed" && result.status !== "not_found";
}

export interface CallbackDeps {
  readonly confirmations: Pick<ConfirmationService, "answer">;
  readonly logger?: Logger;
}

/**
 * Handles `c:<id>:<a|d>` taps. Must be registered after the allowlist middleware. Every tap on
 * one of our buttons is answered exactly once, whatever happens (no endless spinner). Callback
 * data of any other shape is passed on to later handlers.
 */
export function registerConfirmationCallbacks(bot: Bot<Context>, deps: CallbackDeps): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("c:")) {
      await next();
      return;
    }
    let toast = ERROR_TEXT;
    let result: AnswerResult | undefined;
    try {
      const decoded = decodeCallbackData(data);
      const chat = ctx.chat;
      const from = ctx.from;
      const message = ctx.callbackQuery.message;
      if (decoded === null || chat === undefined || message === undefined) {
        deps.logger?.warn("Confirmation callback rejected", { event: "confirmation.rejected", reason: "malformed" });
        toast = REJECTED_TEXT;
      } else if (chat.type !== "private" || chat.id !== from.id) {
        // Bound to the user: only a private chat with the tapping user itself may answer.
        deps.logger?.warn("Confirmation callback rejected", { event: "confirmation.rejected", reason: "not_private" });
        toast = REJECTED_TEXT;
      } else {
        const request: AnswerRequest = {
          id: decoded.id,
          decision: decoded.decision,
          channel: TELEGRAM_CHANNEL,
          externalChatId: chat.id.toString(),
          channelMessageId: String(message.message_id),
        };
        result = await deps.confirmations.answer(request);
        toast = toastFor(result);
      }
    } catch (error) {
      deps.logger?.error("Telegram handler failed", {
        event: "telegram.callback_failed",
        err_type: error instanceof Error ? error.name : typeof error,
      });
    }

    try {
      await ctx.answerCallbackQuery({ text: toast });
    } catch (error) {
      deps.logger?.warn("answerCallbackQuery failed", {
        event: "telegram.callback_answer_failed",
        err_type: error instanceof Error ? error.name : typeof error,
      });
    }
    if (result !== undefined && closesPrompt(result)) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
      } catch (error) {
        deps.logger?.warn("Removing the confirmation keyboard failed", {
          event: "telegram.keyboard_removal_failed",
          err_type: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  });
}
