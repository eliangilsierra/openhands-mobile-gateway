import type { Bot, Context } from "grammy";
import type { ChatStateRepository } from "../../../store/chat-state.js";

export const TELEGRAM_CHANNEL = "telegram";

/** The slice of the #6 repository this command needs. */
export type ChatStateStore = Pick<ChatStateRepository, "find" | "setActiveProject">;

export function registerStart(bot: Bot<Context>, chatState: ChatStateStore): void {
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    let existing = chatState.find(TELEGRAM_CHANNEL, chatId);
    if (existing === null) {
      chatState.setActiveProject(TELEGRAM_CHANNEL, chatId, null);
      existing = chatState.find(TELEGRAM_CHANNEL, chatId);
    }
    const project = existing?.activeProject ?? null;
    const projectLine = project === null ? "No active project yet." : `Active project: ${project}`;
    await ctx.reply(`Hello! I relay your tasks to OpenHands.\n${projectLine}\nSend /help to see the commands.`);
  });
}
