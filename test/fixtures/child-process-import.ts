// Fixture for the ESLint test (T-AC-6). Never imported by production code: importing
// `child_process` must fail lint (architecture §9.4 T-B2-4). Excluded from the TypeScript
// build by tsconfig's `include: ["src"]`.
import { exec } from "node:child_process";

export function runShellCommand(command: string): void {
  exec(command);
}
