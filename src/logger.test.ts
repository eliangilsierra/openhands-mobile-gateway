import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

const FIXED_NOW = () => new Date("2026-10-09T00:00:00.000Z");

function captureLines() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("createLogger", () => {
  it("emits a single-line JSON record with ts, level and msg", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({ level: "info", secrets: [], now: FIXED_NOW, write });

    logger.info("boot ok", { event: "boot.config_ok" });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      ts: "2026-10-09T00:00:00.000Z",
      level: "info",
      msg: "boot ok",
      event: "boot.config_ok",
    });
  });

  it("redacts a known secret value wherever it appears in the log line (T-AC-5)", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({
      level: "info",
      secrets: ["super-secret-token"],
      now: FIXED_NOW,
      write,
    });

    logger.error("OpenHands call failed", {
      event: "openhands.request_failed",
      err_type: "AuthError",
      err_msg: "rejected key super-secret-token for /api/conversations",
    });

    expect(lines[0]).not.toContain("super-secret-token");
    expect(lines[0]).toContain("***");
    const record = JSON.parse(lines[0]);
    expect(record.err_msg).toBe("rejected key *** for /api/conversations");
  });

  it("redacts a secret value even when it is the entire value of an allowed field", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({
      level: "info",
      secrets: ["telegram-bot-token-123"],
      now: FIXED_NOW,
      write,
    });

    logger.info("status", { event: "boot.config_ok", status: "telegram-bot-token-123" });

    const record = JSON.parse(lines[0]);
    expect(record.status).toBe("***");
  });

  it("drops a field that is not on the loggable allowlist at INFO", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({ level: "info", secrets: [], now: FIXED_NOW, write });

    logger.info("task submitted", {
      event: "task.submitted",
      text: "do the thing",
      content: "raw agent output",
      token: "abc",
      api_key: "abc",
      authorization: "Bearer abc",
      working_dir: "/projects/toneprofiler",
      not_on_allowlist: "anything",
    });

    const record = JSON.parse(lines[0]);
    expect(record).not.toHaveProperty("text");
    expect(record).not.toHaveProperty("content");
    expect(record).not.toHaveProperty("token");
    expect(record).not.toHaveProperty("api_key");
    expect(record).not.toHaveProperty("authorization");
    expect(record).not.toHaveProperty("working_dir");
    expect(record).not.toHaveProperty("not_on_allowlist");
    expect(record.event).toBe("task.submitted");
  });

  it("allows working_dir only when the call itself is at DEBUG level", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({ level: "debug", secrets: [], now: FIXED_NOW, write });

    logger.debug("resolving project", {
      event: "project.selected",
      working_dir: "/projects/toneprofiler",
    });
    logger.info("resolving project", {
      event: "project.selected",
      working_dir: "/projects/toneprofiler",
    });

    const debugRecord = JSON.parse(lines[0]);
    const infoRecord = JSON.parse(lines[1]);
    expect(debugRecord.working_dir).toBe("/projects/toneprofiler");
    expect(infoRecord).not.toHaveProperty("working_dir");
  });

  it("never emits text/content/token/api_key/authorization even at DEBUG", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({ level: "debug", secrets: [], now: FIXED_NOW, write });

    logger.debug("debugging", {
      event: "event.received",
      text: "secret message body",
      token: "abc",
    });

    const record = JSON.parse(lines[0]);
    expect(record).not.toHaveProperty("text");
    expect(record).not.toHaveProperty("token");
  });

  it("does not write a line below the configured minimum level", () => {
    const { lines, write } = captureLines();
    const logger = createLogger({ level: "warn", secrets: [], now: FIXED_NOW, write });

    logger.info("should not appear", { event: "boot.config_ok" });
    logger.debug("should not appear either", { event: "boot.config_ok" });
    logger.warn("should appear", { event: "health.degraded" });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe("should appear");
  });
});
