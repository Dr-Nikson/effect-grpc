// packages/e2e-tests/src/readme-check.test.ts
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

const readmeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "readme");

const fixture = (name: string) => join(readmeDir, "fixtures", name);

const run = (script: string, ...args: ReadonlyArray<string>) => {
  const result = spawnSync(process.execPath, [join(readmeDir, script), ...args], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
};

const check = (...markdown: ReadonlyArray<string>) =>
  run("check-readme.mjs", ...markdown.map(fixture));

const checkDocs = (...paths: ReadonlyArray<string>) => run("check-docs.mjs", ...paths);

describe("README check", () => {
  it("compiles the TypeScript blocks of the README and of each decision record in docs/adr", () => {
    const { status, stdout } = checkDocs();
    expect(stdout).toMatch(/^README\.md: [1-9]\d* TypeScript blocks compile/m);
    expect(stdout).toMatch(/^docs\/adr\/[\w.-]+\.md: [1-9]\d* TypeScript blocks compile/m);
    expect(status).toBe(0);
  });

  it("fails the docs check when one document fails, also when a later one passes", () => {
    const { status, stdout } = checkDocs(fixture("js-fence.md"), fixture("streaming-rpc.md"));
    expect(stdout).toContain("js-fence.md:3:1 error fence");
    expect(stdout).toMatch(/streaming-rpc\.md: [1-9]\d* TypeScript blocks compile/);
    expect(status).toBe(1);
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

  it("compiles the code generated for a service that has streaming rpcs (#100)", () => {
    const { status, stdout } = check("streaming-rpc.md");
    expect(stdout).toMatch(/streaming-rpc\.md: [1-9]\d* TypeScript blocks compile/);
    expect(status).toBe(0);
  });
});
