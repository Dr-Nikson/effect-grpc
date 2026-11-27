// packages/effect-grpc/src/readme-check.test.ts
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

const readmeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "readme-check");

const check = (...markdown: ReadonlyArray<string>) => {
  const result = spawnSync(
    process.execPath,
    [
      join(readmeDir, "check-readme.mjs"),
      ...markdown.map((name) => join(readmeDir, "fixtures", name)),
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout };
};

describe("README check", () => {
  it("compiles the README's TypeScript blocks", () => {
    const { status, stdout } = check();
    expect(stdout).toMatch(/README\.md: [1-9]\d* TypeScript blocks compile/);
    expect(status).toBe(0);
  });

  it("fails at the line that calls the removed typed-tag shape", () => {
    const { status, stdout } = check("removed-call.md");
    expect(stdout).toMatch(/removed-call\.md:39:\d+ error TS2349: This expression is not callable/);
    expect(status).toBe(1);
  });

  it("fails on a block fenced as js, so no example skips the compiler", () => {
    const { status, stdout } = check("js-fence.md");
    expect(stdout).toContain("js-fence.md:3:1 error fence: fence this js block as typescript");
    expect(status).toBe(1);
  });
});
