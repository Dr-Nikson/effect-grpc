// .github/scripts/snapshot-version-step.test.mjs
import { load } from "js-yaml";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { evaluate, runs } from "./workflow-expressions.mjs";

const { tag, sha, accepted, refused } = JSON.parse(
  readFileSync(new URL("./fixtures/snapshot-versions.json", import.meta.url), "utf8"),
);
const workflow = load(
  readFileSync(new URL("../workflows/snapshot-release.yml", import.meta.url), "utf8"),
);
const job = workflow.jobs.snapshot;
const changesetConfig = JSON.parse(
  readFileSync(new URL("../../.changeset/config.json", import.meta.url), "utf8"),
);
const fromChangesetsCli = createRequire(
  createRequire(import.meta.url).resolve("@changesets/cli/package.json"),
);
const assembleReleasePlan = fromChangesetsCli("@changesets/assemble-release-plan").default;
const { parse: parseChangesetConfig } = fromChangesetsCli("@changesets/config");

const versionStep = job.steps.find((step) => step.run?.includes("changeset version --snapshot"));
const publishStep = job.steps.find((step) => step.id === "publish");
const versionThroughPublish = job.steps.slice(
  job.steps.indexOf(versionStep),
  job.steps.indexOf(publishStep) + 1,
);

const UNVERSIONED = "3.0.0-alpha.5";
const FAKE_PNPM = fileURLToPath(new URL("./fixtures/fake-pnpm.sh", import.meta.url));
const SHELLS = { bash: "bash --noprofile --norc -eo pipefail {0}", sh: "sh -e {0}" };
const DISPATCH = { event_name: "workflow_dispatch", event: { inputs: { tag } } };
const COMMENT = {
  event_name: "issue_comment",
  event: {
    issue: {
      number: 62,
      pull_request: { url: "https://api.github.com/repos/Dr-Nikson/effect-grpc/pulls/62" },
    },
    comment: { body: "/snapshot", author_association: "OWNER" },
  },
};

const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const splitAtEquals = (line) => [
  line.slice(0, line.indexOf("=")),
  line.slice(line.indexOf("=") + 1),
];

/** The command a Linux runner starts a step's script with. */
function shellCommand(step, script) {
  const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  const template = shell === undefined ? "bash -e {0}" : (SHELLS[shell] ?? shell);
  return template.split(" ").map((word) => word.replace("{0}", script));
}

/**
 * Runs steps of the snapshot job in order, as the runner does, in a scratch checkout where the
 * package is at `before` and the fake changesets CLI versions it to `versioned`. The job's earlier
 * steps count as succeeded. A step runs while its `if:` holds, and a failed step fails the job
 * unless its `continue-on-error` holds.
 */
function runSteps(
  steps,
  { github = DISPATCH, before = UNVERSIONED, versioned = before, preMode = false } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-step-"));
  try {
    mkdirSync(join(dir, "bin"));
    copyFileSync(FAKE_PNPM, join(dir, "bin/pnpm"));
    chmodSync(join(dir, "bin/pnpm"), 0o755);
    mkdirSync(join(dir, "packages/effect-grpc"), { recursive: true });
    const manifest = join(dir, "packages/effect-grpc/package.json");
    writeFileSync(manifest, JSON.stringify({ version: before }));
    if (preMode) {
      mkdirSync(join(dir, ".changeset"));
      writeFileSync(join(dir, ".changeset/pre.json"), JSON.stringify({ mode: "pre" }));
    }
    const contexts = {
      github,
      inputs: github.event.inputs ?? {},
      needs: { validate: { outputs: { kind: "allowed", tag, sha } } },
      env: { SNAPSHOT_TAG: tag, SNAPSHOT_SHA: sha },
      steps: Object.fromEntries(
        job.steps
          .slice(0, job.steps.indexOf(steps[0]))
          .filter((step) => step.id !== undefined)
          .map((step) => [step.id, { outcome: "success", conclusion: "success" }]),
      ),
      ...Object.fromEntries(
        ["job", "runner", "strategy", "matrix", "vars", "secrets"].map((name) => [name, {}]),
      ),
    };
    let status = "success";
    let last = { status: undefined, stdout: "", stderr: "" };
    for (const step of steps) {
      if (!runs(step.if, contexts, status)) continue;
      writeFileSync(join(dir, "step.sh"), step.run);
      const [command, ...args] = shellCommand(step, join(dir, "step.sh"));
      last = spawnSync(command, args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
          SNAPSHOT_TAG: tag,
          SNAPSHOT_SHA: sha,
          GITHUB_OUTPUT: join(dir, "github-output"),
          PUBLISHED: join(dir, "published"),
          VERSIONED: versioned,
        },
      });
      const failed = last.status !== 0 && !evaluate(step["continue-on-error"] ?? false, contexts);
      if (failed) status = "failure";
      if (step.id !== undefined) {
        contexts.steps[step.id] = {
          outcome: last.status === 0 ? "success" : "failure",
          conclusion: failed ? "failure" : "success",
        };
      }
    }
    return {
      status: last.status,
      stdout: last.stdout,
      stderr: last.stderr,
      version: JSON.parse(readFileSync(manifest, "utf8")).version,
      publishedTags: readLines(join(dir, "published")).map(
        (line) => /--tag[= ](\S+)/.exec(line)?.[1],
      ),
      outputs: Object.fromEntries(readLines(join(dir, "github-output")).map(splitAtEquals)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The version that `changeset version --snapshot` gives a major change with this repository's
 * .changeset/config.json, on a package at 3.0.0-alpha.5 once the version step has left pre mode.
 */
function changesetsSnapshot() {
  const workspace = {
    tool: "pnpm",
    root: { dir: "/repo", packageJson: { name: "effect-grpc", version: "0.0.0" } },
    packages: [
      ["@dr_nikson/effect-grpc", UNVERSIONED],
      ["@dr_nikson/effect-grpc-example", "0.1.0"],
      ["@dr_nikson/effect-grpc-e2e-tests", "0.1.0"],
    ].map(([name, version]) => ({ dir: `/repo/${name}`, packageJson: { name, version } })),
  };
  const { releases } = assembleReleasePlan(
    [{ id: "change", summary: "", releases: [{ name: "@dr_nikson/effect-grpc", type: "major" }] }],
    workspace,
    parseChangesetConfig(changesetConfig, workspace),
    { mode: "exit", tag: "alpha", initialVersions: {}, changesets: [] },
    { tag, commit: sha },
  );
  return releases.find(({ name }) => name === "@dr_nikson/effect-grpc").newVersion;
}

for (const version of accepted) {
  test(`the version step lets ${version} through`, () => {
    const result = runSteps([versionStep], { versioned: version });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

for (const { name, version } of refused) {
  test(`the version step fails on ${name}`, () => {
    const result = runSteps([versionStep], { versioned: version });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^::error::/m);
    assert.ok(result.stdout.includes(version), "the error names the version it found");
  });
}

test("the version step makes the snapshot in pre mode and outside it", () => {
  for (const preMode of [true, false]) {
    const result = runSteps([versionStep], { versioned: accepted[0], preMode });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.version, accepted[0]);
  }
});

test("with the changesets settings, a snapshot of 3.0.0-alpha.5 is 3.0.0-0.<tag>.<commit>, which the version step lets through", () => {
  const snapshot = changesetsSnapshot();
  assert.equal(snapshot, `3.0.0-0.${tag}.${sha}`);
  const result = runSteps([versionStep], { versioned: snapshot });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the changesets settings give a snapshot that sorts below every alpha, beta, and rc of its version", () => {
  const snapshot = changesetsSnapshot();
  const [version] = snapshot.split("-");
  for (const channel of ["alpha", "beta", "rc"]) {
    assert.ok(semver.lt(snapshot, `${version}-${channel}`), `${snapshot} sorts below ${channel}`);
  }
});

for (const [trigger, github] of [
  ["a /snapshot comment", COMMENT],
  ["a dispatch", DISPATCH],
]) {
  test(`${trigger} publishes only a version that the version step lets through`, () => {
    for (const { version } of refused) {
      const result = runSteps(versionThroughPublish, { github, versioned: version });
      assert.deepEqual(result.publishedTags, [], version);
    }
    const result = runSteps(versionThroughPublish, { github, versioned: accepted[0] });
    assert.deepEqual(result.publishedTags, [tag]);
  });
}

for (const version of accepted) {
  test(`the publish step publishes under the requested tag and reports ${version}`, () => {
    const result = runSteps([publishStep], { before: version });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.publishedTags, [tag]);
    assert.equal(result.outputs.version, version);
  });
}
