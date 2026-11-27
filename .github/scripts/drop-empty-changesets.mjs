// .github/scripts/drop-empty-changesets.mjs
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTMATTER = /\s*---([^]*?)\n\s*---(\s*(?:\n|$)[^]*)/;

/**
 * Lists the changesets that changesets/action counts as pending: every `.md` file except
 * README.md and dotfiles, minus the ids that pre.json records as consumed in pre mode.
 *
 * @param {string} changesetDir
 * @returns {{ id: string, file: string, empty: boolean }[]}
 */
export function pendingChangesets(changesetDir) {
  const prePath = join(changesetDir, "pre.json");
  const pre = existsSync(prePath) ? JSON.parse(readFileSync(prePath, "utf8")) : undefined;
  const consumed = new Set(pre?.mode === "pre" ? pre.changesets : []);
  return readdirSync(changesetDir)
    .filter((name) => !name.startsWith(".") && name.endsWith(".md") && !/^README\.md$/i.test(name))
    .map((name) => ({ id: name.replace(".md", ""), file: join(changesetDir, name) }))
    .filter(({ id }) => !consumed.has(id))
    .map(({ id, file }) => ({ id, file, empty: hasBlankFrontmatter(readFileSync(file, "utf8")) }));
}

/** @param {string} text */
function hasBlankFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  return match !== null && match[1].trim() === "";
}

/**
 * @param {string} changesetDir
 * @returns {string[]}
 */
export function dropEmptyChangesets(changesetDir) {
  const pending = pendingChangesets(changesetDir);
  const releasing = pending
    .filter((changeset) => !changeset.empty)
    .map((changeset) => changeset.id);
  if (releasing.length > 0) {
    throw new Error(
      `Pending changesets list packages, so a version PR is due: ${releasing.join(", ")}`,
    );
  }
  for (const { file } of pending) rmSync(file);
  return pending.map((changeset) => changeset.id);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dropped = dropEmptyChangesets(process.argv[2] ?? ".changeset");
  console.log(
    dropped.length === 0 ?
      "No pending changesets"
    : `Dropped empty changesets: ${dropped.join(", ")}`,
  );
}
