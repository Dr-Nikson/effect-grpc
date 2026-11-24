// .github/scripts/drop-empty-changesets.mjs
// Usage: node .github/scripts/drop-empty-changesets.mjs [changeset-dir]
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTMATTER = /\s*---([^]*?)\n\s*---(\s*(?:\n|$)[^]*)/;

/**
 * Lists the changesets that changesets/action counts as pending: every `.md` file except
 * README.md and dotfiles, minus the ids that pre.json records as consumed in pre mode.
 *
 * @param {string} dir the `.changeset` directory
 * @returns {{ id: string, file: string, empty: boolean }[]}
 */
export function pendingChangesets(dir) {
  const prePath = join(dir, "pre.json");
  const pre = existsSync(prePath) ? JSON.parse(readFileSync(prePath, "utf8")) : undefined;
  const consumed = new Set(pre?.mode === "pre" ? pre.changesets : []);
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name.endsWith(".md") && !/^README\.md$/i.test(name))
    .map((name) => ({ id: name.replace(".md", ""), file: join(dir, name) }))
    .filter(({ id }) => !consumed.has(id))
    .map(({ id, file }) => ({ id, file, empty: isEmpty(readFileSync(file, "utf8")) }));
}

/**
 * Only a frontmatter of whitespace counts as empty. Anything else, a YAML comment included,
 * counts as a release, so a changeset this check cannot read is never dropped.
 *
 * @param {string} text
 */
function isEmpty(text) {
  const match = FRONTMATTER.exec(text);
  return match !== null && match[1].trim() === "";
}

/**
 * Deletes every pending empty changeset. Throws, and deletes nothing, when a pending
 * changeset lists a package, because that changeset needs a version PR rather than a publish.
 *
 * @param {string} dir the `.changeset` directory
 * @returns {string[]} the ids it deleted
 */
export function dropEmptyChangesets(dir) {
  const pending = pendingChangesets(dir);
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
