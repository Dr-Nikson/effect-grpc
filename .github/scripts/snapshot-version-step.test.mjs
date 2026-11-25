// .github/scripts/snapshot-version-step.test.mjs
import { load } from "js-yaml";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const { tag, sha, accepted, refused } = JSON.parse(
  readFileSync(new URL("./fixtures/snapshot-versions.json", import.meta.url), "utf8"),
);
const { steps } = load(
  readFileSync(new URL("../workflows/snapshot-release.yml", import.meta.url), "utf8"),
).jobs.snapshot;
const { snapshot: snapshotSettings } = JSON.parse(
  readFileSync(new URL("../../.changeset/config.json", import.meta.url), "utf8"),
);

const versionStep = steps.find((step) => step.run?.includes("changeset version --snapshot"));
const publishStep = steps.find((step) => step.id === "publish");

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Runs a step's script the way a Linux runner does for a step without `shell:` (`bash -e`). */
function runStep(step, version) {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-step-"));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "packages/effect-grpc"), { recursive: true });
    writeFileSync(join(dir, "packages/effect-grpc/package.json"), JSON.stringify({ version }));
    writeFileSync(join(dir, "bin/pnpm"), '#!/bin/sh\necho "$@" >> "$PNPM_LOG"\n');
    chmodSync(join(dir, "bin/pnpm"), 0o755);
    writeFileSync(join(dir, "step.sh"), step.run);
    const result = spawnSync("bash", ["-e", join(dir, "step.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
        SNAPSHOT_TAG: tag,
        SNAPSHOT_SHA: sha,
        GITHUB_OUTPUT: join(dir, "github-output"),
        PNPM_LOG: join(dir, "pnpm.log"),
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      pnpmCalls: readIfPresent(join(dir, "pnpm.log")).split("\n").filter(Boolean),
      stepOutput: readIfPresent(join(dir, "github-output")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const version of accepted) {
  test(`the version step lets ${version} through`, () => {
    const result = runStep(versionStep, version);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

for (const { name, version } of refused) {
  test(`the version step fails on ${name}`, () => {
    const result = runStep(versionStep, version);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^::error::/m);
    assert.ok(result.stdout.includes(version), "the error names the version it found");
  });
}

test("the changesets snapshot settings give a calculated version that ends the way the version step checks", () => {
  assert.equal(snapshotSettings.useCalculatedVersion, true);
  const ending = snapshotSettings.prereleaseTemplate.replace("{tag}", tag).replace("{commit}", sha);
  const result = runStep(versionStep, `3.0.0-${ending}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a failed version step stops the job before the publish step", () => {
  assert.ok(steps.indexOf(versionStep) < steps.indexOf(publishStep));
  assert.notEqual(versionStep["continue-on-error"], true);
  assert.equal(versionStep.if, undefined);
  assert.equal(publishStep.if, undefined);
});

for (const version of accepted) {
  test(`the publish step publishes under the requested tag and reports ${version}`, () => {
    const result = runStep(publishStep, version);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.pnpmCalls, [`exec changeset publish --tag ${tag}`]);
    assert.equal(result.stepOutput, `version=${version}\n`);
  });
}
