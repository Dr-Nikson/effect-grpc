// packages/e2e-tests/readme/check-docs.mjs
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const paths =
  process.argv.length > 2 ?
    process.argv.slice(2).map((path) => resolve(path))
  : [join(root, "README.md"), join(root, "docs", "adr")];

const documents = paths.flatMap((path) => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    console.error(`check-docs: ${path} does not exist`);
    process.exit(2);
  }
  return stat.isDirectory() ?
      readdirSync(path)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => join(path, name))
    : [path];
});

let exitCode = 0;
for (const document of documents) {
  const { status } = spawnSync(process.execPath, [join(here, "check-readme.mjs"), document], {
    stdio: "inherit",
  });
  exitCode = Math.max(exitCode, status ?? 2);
}
process.exitCode = exitCode;
