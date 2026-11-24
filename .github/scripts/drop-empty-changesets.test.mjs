// .github/scripts/drop-empty-changesets.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dropEmptyChangesets } from "./drop-empty-changesets.mjs";

const cases = JSON.parse(
  readFileSync(new URL("./fixtures/changeset-dirs.json", import.meta.url), "utf8"),
);

function changesetDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "changesets-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

for (const { name, files, dropped, refused } of cases) {
  test(name, () => {
    const dir = changesetDir(files);
    const before = readdirSync(dir).sort();
    if (refused) {
      assert.throws(
        () => dropEmptyChangesets(dir),
        (error) => refused.every((id) => error.message.includes(id)),
      );
      assert.deepEqual(readdirSync(dir).sort(), before);
      return;
    }
    assert.deepEqual(dropEmptyChangesets(dir).sort(), dropped);
    const expected = before.filter((file) => !dropped.includes(file.replace(/\.md$/, "")));
    assert.deepEqual(readdirSync(dir).sort(), expected);
  });
}
