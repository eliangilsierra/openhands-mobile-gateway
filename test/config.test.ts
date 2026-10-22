import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, secretValues } from "../src/config.js";

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
      healthHost: "127.0.0.1",
      healthCacheSeconds: 15,
      timezone: "Europe/Madrid",
      eventPollSeconds: 5,
      wsIdleSeconds: 900,
      maxTaskChars: 8000,
      retentionDays: 30,
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

describe("HEALTH_PORT format", () => {
  it.each(["8080abc", "80.5", "1e3", "0x50", "-1", "", "0", "65536"])("rejects %j", (port) => {
    expect(() => loadConfig({ ...VALID_ENV, HEALTH_PORT: port })).toThrow(ConfigError);
  });

  it.each([
    ["1", 1],
    ["8080", 8080],
    ["65535", 65535],
  ])("accepts %s", (port, expected) => {
    expect(loadConfig({ ...VALID_ENV, HEALTH_PORT: port }).healthPort).toBe(expected);
  });
});

describe("secretValues", () => {
  it("lists exactly the two known secret values from the config", () => {
    const config = loadConfig({ ...VALID_ENV });

    expect(secretValues(config)).toEqual(["telegram-secret-token", "canvas-secret-key"]);
  });

  it("also lists the URL-encoded form of a token that contains reserved characters", () => {
    const config = loadConfig({ ...VALID_ENV, TELEGRAM_BOT_TOKEN: "123456:ABC-def_ghi" });

    expect(secretValues(config)).toContain("123456:ABC-def_ghi");
    expect(secretValues(config)).toContain("123456%3AABC-def_ghi");
  });
});

describe("TELEGRAM_ALLOWED_USER_IDS bounds", () => {
  it.each(["0", "-5", "111,0", "9007199254740992", "99999999999999999999", "1.5", "abc"])(
    "rejects %s",
    (value) => {
      expect(() => loadConfig({ ...VALID_ENV, TELEGRAM_ALLOWED_USER_IDS: value })).toThrow(ConfigError);
    },
  );

  it("accepts the largest safe integer", () => {
    const config = loadConfig({ ...VALID_ENV, TELEGRAM_ALLOWED_USER_IDS: String(Number.MAX_SAFE_INTEGER) });

    expect(config.telegramAllowedUserIds).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it("does not echo the offending value in the error", () => {
    expect(() => loadConfig({ ...VALID_ENV, TELEGRAM_ALLOWED_USER_IDS: "99999999999999999999" })).toThrow(
      /^(?!.*99999999999999999999)/,
    );
  });
});

describe("health settings", () => {
  it("defaults to loopback and a 15 s cache", () => {
    const { HEALTH_PORT: _port, ...rest } = VALID_ENV;
    const config = loadConfig(rest);

    expect(config.healthHost).toBe("127.0.0.1");
    expect(config.healthCacheSeconds).toBe(15);
  });

  it("accepts an explicit host and a zero or fractional cache", () => {
    expect(loadConfig({ ...VALID_ENV, HEALTH_HOST: "0.0.0.0" }).healthHost).toBe("0.0.0.0");
    expect(loadConfig({ ...VALID_ENV, HEALTH_CACHE_SECONDS: "0" }).healthCacheSeconds).toBe(0);
    expect(loadConfig({ ...VALID_ENV, HEALTH_CACHE_SECONDS: "2.5" }).healthCacheSeconds).toBe(2.5);
  });

  it.each(["-1", "abc", "", "1e3", "Infinity", "NaN"])("rejects HEALTH_CACHE_SECONDS=%j", (value) => {
    expect(() => loadConfig({ ...VALID_ENV, HEALTH_CACHE_SECONDS: value })).toThrow(ConfigError);
  });

  it.each(["not a host", "", "example.com;x"])("rejects HEALTH_HOST=%j", (value) => {
    expect(() => loadConfig({ ...VALID_ENV, HEALTH_HOST: value })).toThrow(ConfigError);
  });
});

describe("event and task settings", () => {
  it("accepts explicit values at the bounds", () => {
    const config = loadConfig({
      ...VALID_ENV,
      EVENT_POLL_SECONDS: "300",
      WS_IDLE_SECONDS: "1",
      MAX_TASK_CHARS: "32000",
      RETENTION_DAYS: "3650",
    });

    expect(config.retentionDays).toBe(3650);
    expect(loadConfig({ ...VALID_ENV, RETENTION_DAYS: "1" }).retentionDays).toBe(1);
    expect(config.eventPollSeconds).toBe(300);
    expect(config.wsIdleSeconds).toBe(1);
    expect(config.maxTaskChars).toBe(32000);
  });

  it.each([
    ["EVENT_POLL_SECONDS", "0"],
    ["EVENT_POLL_SECONDS", "301"],
    ["EVENT_POLL_SECONDS", "2.5"],
    ["WS_IDLE_SECONDS", "0"],
    ["WS_IDLE_SECONDS", "86401"],
    ["WS_IDLE_SECONDS", "abc"],
    ["MAX_TASK_CHARS", "0"],
    ["MAX_TASK_CHARS", "32001"],
    ["MAX_TASK_CHARS", ""],
    ["MAX_TASK_CHARS", "-5"],
    ["RETENTION_DAYS", "0"],
    ["RETENTION_DAYS", "3651"],
    ["RETENTION_DAYS", "1.5"],
    ["RETENTION_DAYS", "abc"],
    ["RETENTION_DAYS", ""],
    ["RETENTION_DAYS", "-1"],
  ])("rejects %s=%j", (key, value) => {
    expect(() => loadConfig({ ...VALID_ENV, [key]: value })).toThrow(ConfigError);
  });
});
