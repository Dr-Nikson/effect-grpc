// packages/e2e-tests/readme/check-docs.mjs
//
// Runs check-readme.mjs on each Markdown document named on the command line, one document at a
// time, because each one is its own scratch project with its own protos. A directory stands for
// the .md files directly inside it. With no arguments it checks README.md and docs/adr/, so every
// decision record that is added there is checked without a change to this script.
//
// usage: node packages/e2e-tests/readme/check-docs.mjs [file or directory]...
// Exit code: the highest exit code of check-readme.mjs over the documents, 2 for a missing path.
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
