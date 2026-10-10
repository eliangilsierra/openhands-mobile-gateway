import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import type { ProjectEntry, ProjectRegistry } from "../../../core/projects.js";

export const MAX_PROJECT_BUTTONS = 8;
export const USE_CALLBACK_PREFIX = "use:";
/** Telegram limits `callback_data` to 64 bytes. */
const MAX_CALLBACK_BYTES = 64;

export const NO_SOURCE_TEXT =
  "⚠️ No pude obtener la lista de proyectos. Pide al operador que configure PROJECTS.";
export const UNAVAILABLE_TEXT = "⚠️ OpenHands no está disponible. Inténtalo de nuevo más tarde.";
export const EMPTY_TEXT = "No hay proyectos disponibles.";

export function formatProjectList(projects: readonly ProjectEntry[]): string {
  return ["Proyectos disponibles:", ...projects.map((project, index) => `${index + 1}. ${project.key}`)].join("\n");
}

export function projectKeyboard(projects: readonly ProjectEntry[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const buttons = projects
    .map((project) => ({ project, data: `${USE_CALLBACK_PREFIX}${project.key}` }))
    .filter(({ data }) => Buffer.byteLength(data, "utf8") <= MAX_CALLBACK_BYTES)
    .slice(0, MAX_PROJECT_BUTTONS);
  buttons.forEach(({ project, data }, index) => {
    keyboard.text(project.key, data);
    if (index % 2 === 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

/** `/projects`: numbered list plus an inline keyboard of up to 8 buttons (`ListProjects` intent). */
export function registerProjects(bot: Bot<Context>, registry: Pick<ProjectRegistry, "list">): void {
  bot.command("projects", async (ctx) => {
    const result = await registry.list();
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
