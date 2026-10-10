import type { Bot, Context } from "grammy";

/** Static command list; commands not implemented yet are listed on purpose (later tasks). */
export const HELP_TEXT = [
  "Commands:",
  "/start - greeting and current project",
  "/help - this list",
  "/projects - list available projects",
  "/use <key> - select the active project",
  "/status - show the current task status",
  "/pause - pause the running task",
  "/resume - resume the paused task",
  "/stop - stop the running task",
  "",
  "Any other text is sent as a task to the active project.",
].join("\n");

export function registerHelp(bot: Bot<Context>): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });
}
