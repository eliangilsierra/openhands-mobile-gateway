import { isIP } from "node:net";
import { z } from "zod";

/**
 * Single source of truth for Gateway configuration (architecture §14, §9.1 B4).
 *
 * No other module reads `process.env` directly: this is the seam later tasks' tests mock
 * against. Validation fails fast (non-zero exit, see `src/main.ts`) on a missing/empty
 * `TELEGRAM_BOT_TOKEN`, a missing/empty `OPENHANDS_API_KEY`, or an empty/unparseable
 * `TELEGRAM_ALLOWED_USER_IDS` (architecture §9.1 B4, §7.1).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface GatewayConfig {
  readonly openhandsBaseUrl: string;
  readonly openhandsApiKey: string;
  readonly telegramBotToken: string;
  readonly telegramAllowedUserIds: readonly number[];
  readonly projectsRoot: string;
  readonly projects: readonly string[] | null;
  readonly databasePath: string;
  readonly logLevel: LogLevel;
  readonly healthPort: number;
  /** Bind address of `/health`; loopback unless the operator opts into the Docker network. */
  readonly healthHost: string;
  /** Max age in seconds of the cached OpenHands probe behind `/health` (0 disables the cache). */
  readonly healthCacheSeconds: number;
  readonly timezone: string;
}

/** Raised when the environment fails validation. Never carries a raw secret value. */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const requiredNonEmpty = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} must not be empty`);

const telegramAllowedUserIds = z
  .string()
  .trim()
  .min(1, "TELEGRAM_ALLOWED_USER_IDS must not be empty")
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^\d+$/, "TELEGRAM_ALLOWED_USER_IDS entries must be positive integers")
          .refine(
            (part) => {
              const id = Number(part);
              return Number.isSafeInteger(id) && id > 0;
            },
            "TELEGRAM_ALLOWED_USER_IDS entries must be positive integers within the safe range",
          ),
      )
      .min(1, "TELEGRAM_ALLOWED_USER_IDS must list at least one id"),
  )
  .transform((parts) => parts.map((part) => Number.parseInt(part, 10)));

const optionalProjectList = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return null;
    }
    const projects = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return projects.length > 0 ? projects : null;
  });

const healthPort = z
  .string()
  .optional()
  .default("8080")
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(1, "HEALTH_PORT must be a valid TCP port").max(65535, "HEALTH_PORT must be a valid TCP port"));

const healthHost = z
  .string()
  .trim()
  .optional()
  .default("127.0.0.1")
  .refine(
    (value) => value === "localhost" || isIP(value) !== 0,
    "HEALTH_HOST must be an IP address or localhost",
  );

const healthCacheSeconds = z
  .string()
  .trim()
  .optional()
  .default("15")
  .refine((value) => /^\d+(\.\d+)?$/.test(value), "HEALTH_CACHE_SECONDS must be a non-negative number")
  .transform((value) => Number(value))
  .pipe(z.number().finite("HEALTH_CACHE_SECONDS must be a non-negative number"));

const logLevel = z
  .string()
  .optional()
  .default("info")
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(["debug", "info", "warn", "error"]));

const EnvSchema = z.object({
  OPENHANDS_BASE_URL: requiredNonEmpty("OPENHANDS_BASE_URL")
    .default("http://agentcanvas:8000")
    .refine(isValidUrl, "OPENHANDS_BASE_URL must be a valid URL"),
  OPENHANDS_API_KEY: requiredNonEmpty("OPENHANDS_API_KEY"),
  TELEGRAM_BOT_TOKEN: requiredNonEmpty("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_ALLOWED_USER_IDS: telegramAllowedUserIds,
  PROJECTS_ROOT: requiredNonEmpty("PROJECTS_ROOT").default("/projects"),
  PROJECTS: optionalProjectList,
  DATABASE_PATH: requiredNonEmpty("DATABASE_PATH").default("/data/gateway.db"),
  LOG_LEVEL: logLevel,
  HEALTH_PORT: healthPort,
  HEALTH_HOST: healthHost,
  HEALTH_CACHE_SECONDS: healthCacheSeconds,
  TZ: requiredNonEmpty("TZ").default("UTC"),
});

/** The environment variable names `config.ts` reads. Kept in sync with `.env.example`. */
export const CONFIG_ENV_KEYS = [
  "OPENHANDS_BASE_URL",
  "OPENHANDS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "PROJECTS_ROOT",
  "PROJECTS",
  "DATABASE_PATH",
  "LOG_LEVEL",
  "HEALTH_PORT",
  "HEALTH_HOST",
  "HEALTH_CACHE_SECONDS",
  "TZ",
] as const;

/** Secret values the logger's redaction hook must never emit (architecture §9.2). */
export function secretValues(config: GatewayConfig): readonly string[] {
  // The bot token also appears percent-encoded (":" becomes "%3A") when it travels inside a URL
  // such as an error message carrying the Bot API endpoint, so both forms are redacted.
  const values = [config.telegramBotToken, config.openhandsApiKey];
  for (const secret of [config.telegramBotToken, config.openhandsApiKey]) {
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      values.push(encoded);
    }
  }
  return values;
}

/**
 * Validates `env` against the Gateway's configuration contract and returns a typed,
 * immutable config object. Throws {@link ConfigError} on the first problem, with a message
 * built only from field names and constraint descriptions — never from the raw input value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  const parsed = result.data;

  return {
    openhandsBaseUrl: parsed.OPENHANDS_BASE_URL,
    openhandsApiKey: parsed.OPENHANDS_API_KEY,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS,
    projectsRoot: parsed.PROJECTS_ROOT,
    projects: parsed.PROJECTS,
    databasePath: parsed.DATABASE_PATH,
    logLevel: parsed.LOG_LEVEL,
    healthPort: parsed.HEALTH_PORT,
    healthHost: parsed.HEALTH_HOST,
    healthCacheSeconds: parsed.HEALTH_CACHE_SECONDS,
    timezone: parsed.TZ,
  };
}
