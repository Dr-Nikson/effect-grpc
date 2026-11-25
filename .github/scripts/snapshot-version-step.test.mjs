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
import semver from "semver";

const { tag, sha, accepted, refused } = JSON.parse(
  readFileSync(new URL("./fixtures/snapshot-versions.json", import.meta.url), "utf8"),
);
const workflow = load(
  readFileSync(new URL("../workflows/snapshot-release.yml", import.meta.url), "utf8"),
);
const { steps } = workflow.jobs.snapshot;
const { snapshot: snapshotSettings } = JSON.parse(
  readFileSync(new URL("../../.changeset/config.json", import.meta.url), "utf8"),
);

const versionStep = steps.find((step) => step.run?.includes("changeset version --snapshot"));
const publishStep = steps.find((step) => step.id === "publish");

const UNVERSIONED = "3.0.0-alpha.5";
const FAKE_PNPM = [
  "#!/bin/sh",
  'echo "$@" >> "$PNPM_LOG"',
  'if [ "$3" = "version" ]; then printf \'{"version":"%s"}\' "$VERSIONED" > packages/effect-grpc/package.json; fi',
  "",
].join("\n");

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Runs a step's script the way a Linux runner does for a step without `shell:` (`bash -e`). */
function runStep(step, { before, versioned = before, preMode = false }) {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-step-"));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "packages/effect-grpc"), { recursive: true });
    writeFileSync(
      join(dir, "packages/effect-grpc/package.json"),
      JSON.stringify({ version: before }),
    );
    if (preMode) {
      mkdirSync(join(dir, ".changeset"));
      writeFileSync(join(dir, ".changeset/pre.json"), JSON.stringify({ mode: "pre" }));
    }
    writeFileSync(join(dir, "bin/pnpm"), FAKE_PNPM);
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
        VERSIONED: versioned,
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

const settingsEnding = snapshotSettings.prereleaseTemplate
  .replace("{tag}", tag)
  .replace("{commit}", sha);

for (const version of accepted) {
  test(`the version step lets ${version} through`, () => {
    const result = runStep(versionStep, { before: UNVERSIONED, versioned: version });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

for (const { name, version } of refused) {
  test(`the version step fails on ${name}`, () => {
    const result = runStep(versionStep, { before: UNVERSIONED, versioned: version });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^::error::/m);
    assert.ok(result.stdout.includes(version), "the error names the version it found");
  });
}

test("the version step leaves pre mode before it versions, and only when the repository is in pre mode", () => {
  const versioning = `exec changeset version --snapshot ${tag}`;
  const inPreMode = runStep(versionStep, {
    before: UNVERSIONED,
    versioned: accepted[0],
    preMode: true,
  });
  assert.equal(inPreMode.status, 0, inPreMode.stdout + inPreMode.stderr);
  assert.deepEqual(inPreMode.pnpmCalls, ["exec changeset pre exit", versioning]);
  const outsidePreMode = runStep(versionStep, { before: UNVERSIONED, versioned: accepted[0] });
  assert.deepEqual(outsidePreMode.pnpmCalls, [versioning]);
});

test("the changesets snapshot settings give a version that the version step lets through", () => {
  assert.equal(snapshotSettings.useCalculatedVersion, true);
  const result = runStep(versionStep, {
    before: UNVERSIONED,
    versioned: `3.0.0-${settingsEnding}`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the changesets snapshot settings give a version that sorts below every alpha, beta, and rc of its base", () => {
  const snapshot = `3.0.0-${settingsEnding}`;
  assert.notEqual(semver.valid(snapshot), null);
  for (const channel of ["alpha", "beta", "rc"]) {
    assert.ok(semver.lt(snapshot, `3.0.0-${channel}`), `${snapshot} sorts below ${channel}`);
  }
});

test("the snapshot steps run in the runner's default shell, which is the one these tests use", () => {
  assert.equal(workflow.defaults, undefined);
  assert.equal(workflow.jobs.snapshot.defaults, undefined);
  assert.equal(versionStep.shell, undefined);
  assert.equal(publishStep.shell, undefined);
});

test("a failed version step stops the job before the publish step", () => {
  assert.ok(steps.indexOf(versionStep) < steps.indexOf(publishStep));
  assert.notEqual(versionStep["continue-on-error"], true);
  assert.equal(versionStep.if, undefined);
  assert.equal(publishStep.if, undefined);
});

for (const version of accepted) {
  test(`the publish step publishes under the requested tag and reports ${version}`, () => {
    const result = runStep(publishStep, { before: version });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.pnpmCalls, [`exec changeset publish --tag ${tag}`]);
    assert.equal(result.stepOutput, `version=${version}\n`);
  });
}
