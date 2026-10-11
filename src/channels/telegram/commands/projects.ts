import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import type { Logger } from "../../../logger.js";
import type { ProjectEntry, ProjectRegistry } from "../../../core/projects.js";

export const MAX_PROJECT_BUTTONS = 8;
export const USE_CALLBACK_PREFIX = "use:";
/** Telegram limits `callback_data` to 64 bytes. */
const MAX_CALLBACK_BYTES = 64;

export const NO_SOURCE_TEXT =
  "⚠️ No pude obtener la lista de proyectos. Pide al operador que configure PROJECTS.";
export const UNAVAILABLE_TEXT = "⚠️ OpenHands no está disponible. Inténtalo de nuevo más tarde.";
export const EMPTY_TEXT = "No hay proyectos disponibles.";
export const ERROR_TEXT = "⚠️ Ocurrió un error inesperado. Inténtalo de nuevo más tarde.";
/** Telegram rejects messages above 4096 characters; keep a margin for the "+N more" line. */
export const MAX_MESSAGE_CHARS = 4000;
const HEADER = "Proyectos disponibles:";

/** Logs only the event name and the error type, never the message (it may carry upstream data). */
export function logHandlerError(logger: Logger | undefined, event: string, error: unknown): void {
  logger?.error("Telegram handler failed", {
    event,
    err_type: error instanceof Error ? error.name : typeof error,
  });
}

export function formatProjectList(projects: readonly ProjectEntry[]): string {
  const lines = [HEADER];
  let length = HEADER.length;
  for (const [index, project] of projects.entries()) {
    const line = `${index + 1}. ${project.key}`;
    const remaining = projects.length - index;
    const footer = `+${remaining} más`;
    const isLast = remaining === 1;
    // Keep room for the footer unless this is the last line and fits on its own.
    const reserve = isLast ? 0 : footer.length + 1;
    if (length + 1 + line.length + reserve > MAX_MESSAGE_CHARS) {
      lines.push(footer);
      break;
    }
    lines.push(line);
    length += 1 + line.length;
  }
  return lines.join("\n");
}

export function projectKeyboard(projects: readonly ProjectEntry[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const buttons = projects
    .map((project) => ({ project, data: `${USE_CALLBACK_PREFIX}${project.key}` }))
    .filter(({ data }) => Buffer.byteLength(data, "utf8") <= MAX_CALLBACK_BYTES)
    .slice(0, MAX_PROJECT_BUTTONS);
  buttons.forEach(({ project, data }, index) => {
    keyboard.text(project.key, data);
    if (index % 2 === 1 && index < buttons.length - 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

/** `/projects`: numbered list plus an inline keyboard of up to 8 buttons (`ListProjects` intent). */
export function registerProjects(
  bot: Bot<Context>,
  registry: Pick<ProjectRegistry, "list">,
  logger?: Logger,
): void {
  bot.command("projects", async (ctx) => {
    let result: Awaited<ReturnType<ProjectRegistry["list"]>>;
    try {
      result = await registry.list();
    } catch (error) {
      logHandlerError(logger, "telegram.projects_failed", error);
      await ctx.reply(ERROR_TEXT);
      return;
    }
    if (result.status === "no_source") {
      await ctx.reply(NO_SOURCE_TEXT);
      return;
    }
    if (result.status === "unavailable") {
      await ctx.reply(UNAVAILABLE_TEXT);
      return;
    }
    if (result.projects.length === 0) {
      await ctx.reply(EMPTY_TEXT);
      return;
    }
    await ctx.reply(formatProjectList(result.projects), { reply_markup: projectKeyboard(result.projects) });
  });
}
