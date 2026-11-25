// .github/scripts/move-effect-dist-tag.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { distTagArguments } from "./move-effect-dist-tag.mjs";

const cases = JSON.parse(
  readFileSync(new URL("./fixtures/dist-tag-manifests.json", import.meta.url), "utf8"),
);
const script = fileURLToPath(new URL("./move-effect-dist-tag.mjs", import.meta.url));

const FAKE_NPM = [
  "#!/usr/bin/env node",
  'require("node:fs").writeFileSync(process.env.NPM_ARGS_FILE, JSON.stringify(process.argv.slice(2)));',
  "process.exit(Number(process.env.NPM_STATUS));",
  "",
].join("\n");

function runWithFakeNpm(manifest, npmStatus) {
  const dir = mkdtempSync(join(tmpdir(), "dist-tag-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "npm"), 0o755);
  const manifestFile = join(dir, "package.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const recorded = join(dir, "npm-args.json");
  const { status } = spawnSync(process.execPath, [script, manifestFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      NPM_ARGS_FILE: recorded,
      NPM_STATUS: String(npmStatus),
    },
  });
  return {
    status,
    args: existsSync(recorded) ? JSON.parse(readFileSync(recorded, "utf8")) : undefined,
  };
}

for (const { name, manifest, args } of cases.accepted) {
  test(`points the Effect dist-tag at ${name}`, () => {
    assert.deepEqual(distTagArguments(manifest), args);
  });
}

for (const { name, manifest } of cases.refused) {
  test(`refuses ${name}`, () => {
    assert.throws(() => distTagArguments(manifest));
  });
}

test("runs npm dist-tag add for the version in the manifest and exits 0 when npm does", () => {
  const { manifest, args } = cases.accepted[0];
  assert.deepEqual(runWithFakeNpm(manifest, 0), { status: 0, args });
});

test("exits non-zero when npm fails, so the publish job turns red", () => {
  const { manifest, args } = cases.accepted[0];
  const run = runWithFakeNpm(manifest, 1);
  assert.deepEqual(run.args, args);
  assert.notEqual(run.status, 0);
});

test("never runs npm for a manifest it refuses", () => {
  for (const { name, manifest } of cases.refused) {
    const run = runWithFakeNpm(manifest, 0);
    assert.equal(run.args, undefined, name);
    assert.notEqual(run.status, 0, name);
  }
});
