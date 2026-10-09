import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, secretValues } from "./config.js";

const VALID_ENV = {
  OPENHANDS_BASE_URL: "http://agentcanvas:8000",
  OPENHANDS_API_KEY: "canvas-secret-key",
  TELEGRAM_BOT_TOKEN: "telegram-secret-token",
  TELEGRAM_ALLOWED_USER_IDS: "111, 222 ,333",
  PROJECTS_ROOT: "/projects",
  DATABASE_PATH: "/data/gateway.db",
  LOG_LEVEL: "debug",
  HEALTH_PORT: "9090",
  TZ: "Europe/Madrid",
} as const;

describe("loadConfig", () => {
  it("parses a fully valid environment into the expected typed config object", () => {
    const config = loadConfig({ ...VALID_ENV });

    expect(config).toEqual({
      openhandsBaseUrl: "http://agentcanvas:8000",
      openhandsApiKey: "canvas-secret-key",
      telegramBotToken: "telegram-secret-token",
      telegramAllowedUserIds: [111, 222, 333],
      projectsRoot: "/projects",
      projects: null,
      databasePath: "/data/gateway.db",
      logLevel: "debug",
      healthPort: 9090,
      timezone: "Europe/Madrid",
    });
  });

  it("parses a comma-separated PROJECTS override", () => {
    const config = loadConfig({ ...VALID_ENV, PROJECTS: "toneprofiler, code-sentinel" });

    expect(config.projects).toEqual(["toneprofiler", "code-sentinel"]);
  });

  it("applies defaults for optional variables when they are unset", () => {
    const env = { ...VALID_ENV };
    // @ts-expect-error -- deliberately removing optional keys to exercise defaults
    delete env.LOG_LEVEL;
    // @ts-expect-error -- deliberately removing optional keys to exercise defaults
    delete env.HEALTH_PORT;
    // @ts-expect-error -- deliberately removing optional keys to exercise defaults
    delete env.TZ;
    // @ts-expect-error -- deliberately removing optional keys to exercise defaults
    delete env.OPENHANDS_BASE_URL;
    // @ts-expect-error -- deliberately removing optional keys to exercise defaults
    delete env.PROJECTS_ROOT;
    // @ts-expect-error -- deliberately removing optional keys to exercise defaults
    delete env.DATABASE_PATH;

    const config = loadConfig(env);

    expect(config.logLevel).toBe("info");
    expect(config.healthPort).toBe(8080);
    expect(config.timezone).toBe("UTC");
    expect(config.openhandsBaseUrl).toBe("http://agentcanvas:8000");
    expect(config.projectsRoot).toBe("/projects");
    expect(config.databasePath).toBe("/data/gateway.db");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("throws ConfigError when TELEGRAM_BOT_TOKEN is %s", (_label, value) => {
    const env = { ...VALID_ENV, TELEGRAM_BOT_TOKEN: value } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("throws ConfigError when OPENHANDS_API_KEY is %s", (_label, value) => {
    const env = { ...VALID_ENV, OPENHANDS_API_KEY: value } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["unparseable", "not-a-number"],
    ["mixed valid/invalid", "111,abc,333"],
  ])("throws ConfigError when TELEGRAM_ALLOWED_USER_IDS is %s", (_label, value) => {
    const env = { ...VALID_ENV, TELEGRAM_ALLOWED_USER_IDS: value } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("throws ConfigError with a message that never contains the raw secret values", () => {
    const env = { ...VALID_ENV, TELEGRAM_BOT_TOKEN: "" };

    try {
      loadConfig(env);
      expect.fail("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(VALID_ENV.OPENHANDS_API_KEY);
    }
  });

  it("rejects an invalid OPENHANDS_BASE_URL", () => {
    const env = { ...VALID_ENV, OPENHANDS_BASE_URL: "not a url" };

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("rejects a HEALTH_PORT outside the valid TCP port range", () => {
    const env = { ...VALID_ENV, HEALTH_PORT: "70000" };

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe("secretValues", () => {
  it("lists exactly the two known secret values from the config", () => {
    const config = loadConfig({ ...VALID_ENV });

    expect(secretValues(config)).toEqual(["telegram-secret-token", "canvas-secret-key"]);
  });
});
