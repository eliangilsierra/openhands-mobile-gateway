import { readFile } from "node:fs/promises";
import path from "node:path";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";
import projectEslintConfig from "../eslint.config.js";

/**
 * T-AC-6: a file importing `child_process` or `node:child_process` must fail `eslint`
 * (architecture §9.4 T-B2-4, ADR-0002 point 3).
 *
 * `test/fixtures/**` is excluded from the repo-wide `eslint .` run (so `npm run lint` stays
 * clean) but must still fail against the project's real rules here, so this test builds an
 * ESLint instance from the same config minus that one `ignores` entry.
 */
function configWithoutFixtureIgnore(): Linter.Config[] {
  return (projectEslintConfig as Linter.Config[]).filter(
    (entry) => !(Object.keys(entry).length === 1 && "ignores" in entry),
  );
}

describe("eslint no-restricted-imports (child_process ban)", () => {
  it("fails lint for a fixture file that imports node:child_process", async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: true,
      overrideConfig: configWithoutFixtureIgnore(),
    });
    const fixturePath = path.join(process.cwd(), "test/fixtures/child-process-import.ts");
    const source = await readFile(fixturePath, "utf-8");

    const results = await eslint.lintText(source, { filePath: fixturePath });

    const errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
    const messages = results.flatMap((result) => result.messages);

    expect(errorCount).toBeGreaterThan(0);
    expect(messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(true);
  });

  it("passes lint for a fixture file that imports an unrelated built-in module", async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: true,
      overrideConfig: configWithoutFixtureIgnore(),
    });
    const source = 'import { randomUUID } from "node:crypto";\n\nexport const id = randomUUID();\n';

    const results = await eslint.lintText(source, {
      filePath: path.join(process.cwd(), "test/fixtures/unrelated-import.ts"),
    });

    const restrictedImportErrors = results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === "no-restricted-imports");

    expect(restrictedImportErrors).toHaveLength(0);
  });
});
