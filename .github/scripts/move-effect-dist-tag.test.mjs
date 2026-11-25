// .github/scripts/move-effect-dist-tag.test.mjs
import { load } from "js-yaml";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Evaluator, Lexer, Parser, data } from "@actions/expressions";

import { evaluate, runs } from "./workflow-expressions.mjs";

const { setupNodeNpm, latest, tagMoves, refused } = JSON.parse(
  readFileSync(new URL("./fixtures/dist-tag-manifests.json", import.meta.url), "utf8"),
);
const workflow = load(readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8"));
const versionJob = workflow.jobs["version-pr"];
const publishJob = workflow.jobs.publish;

const NAME = "@dr_nikson/effect-grpc";
const TAG = "effect-v4";
const repoPath = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const FAKE_TOOLS = fileURLToPath(new URL("./fixtures/fake-release-tools.mjs", import.meta.url));
const SHELLS = { bash: "bash --noprofile --norc -eo pipefail {0}", sh: "sh -e {0}" };
const NO_VERSION_PR = { published: "false", publishedPackages: "[]", hasChangesets: "false" };
const OPEN_VERSION_PR = { ...NO_VERSION_PR, hasChangesets: "true", pullRequestNumber: "101" };

/** What each action of the release jobs does here: the command it runs, or nothing. */
const ACTIONS = {
  "actions/checkout": () => undefined,
  "pnpm/action-setup": () => undefined,
  "actions/setup-node": () => undefined,
  "actions/download-artifact": () => undefined,
  "changesets/action": (step) => step.with.publish,
};

function actionCommand(step) {
  const model = ACTIONS[step.uses.split("@")[0]];
  assert.ok(model !== undefined, `the test has no model of ${step.uses}`);
  return model(step);
}

function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A registry that holds the Effect 3 build under `latest`, and `tagged` under effect-v4. */
function registry(t, { tagged, published = [], allowDistTag = true }) {
  const file = join(tempDir(t, "release-registry-"), "registry.json");
  const versions = [latest, ...published, ...(tagged === undefined ? [] : [tagged])];
  writeFileSync(
    file,
    JSON.stringify({
      name: NAME,
      allowDistTag,
      versions: Object.fromEntries(versions.map((v) => [v, { publishedWith: setupNodeNpm }])),
      distTags: tagged === undefined ? { latest } : { latest, [TAG]: tagged },
      distTagRequests: [],
    }),
  );
  return file;
}

const readRegistry = (file) => JSON.parse(readFileSync(file, "utf8"));
const updateRegistry = (file, change) =>
  writeFileSync(file, JSON.stringify({ ...readRegistry(file), ...change }));

/**
 * A checkout of a release commit as the release jobs see it, with the library's manifest, a copy
 * of .github and the changesets config, and the fake npm and pnpm first on PATH.
 */
function checkout(t, registryFile, manifest) {
  const root = tempDir(t, "release-checkout-");
  cpSync(repoPath(".github"), join(root, ".github"), { recursive: true });
  symlinkSync(repoPath("node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, ".changeset"));
  copyFileSync(repoPath(".changeset/config.json"), join(root, ".changeset/config.json"));
  mkdirSync(join(root, "packages/effect-grpc/dist"), { recursive: true });
  writeFileSync(join(root, "packages/effect-grpc/package.json"), JSON.stringify(manifest));
  mkdirSync(join(root, "bin"));
  for (const tool of ["npm", "pnpm"]) {
    writeFileSync(join(root, "bin", tool), `#!/bin/sh\nexec node '${FAKE_TOOLS}' ${tool} "$@"\n`);
    chmodSync(join(root, "bin", tool), 0o755);
  }
  return { root, registryFile };
}

const library = (version) => ({ name: NAME, version });

function environment({ root, registryFile }, outputFile, env = {}) {
  return {
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: outputFile,
    FAKE_REGISTRY: registryFile,
    FAKE_RUNNER: join(root, "runner.json"),
    ...env,
  };
}

/** A `${{ }}` template of `env:` or `outputs:`, filled in as the runner fills it in. */
function interpolate(template, contexts) {
  return String(template).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => {
    const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(contexts), []).parse();
    const context = JSON.parse(JSON.stringify(contexts), data.reviver);
    return new Evaluator(ast, context).evaluate().coerceString();
  });
}

function shellCommand(job, step, script) {
  const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  const template = shell === undefined ? "bash -e {0}" : (SHELLS[shell] ?? shell);
  return template.split(" ").map((word) => word.replace("{0}", script));
}

function readOutputs(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return Object.fromEntries(lines.map((line) => line.split(/=(.*)/s, 2)));
}

/**
 * Runs steps on a fresh runner, as GitHub does: a step runs while its `if:` holds, its `env:` is
 * filled in, it writes its outputs to its own GITHUB_OUTPUT, and a failed step fails the job
 * unless its `continue-on-error` holds.
 */
function runSteps(release, job, steps, contexts) {
  writeFileSync(join(release.root, "runner.json"), JSON.stringify({ npm: setupNodeNpm }));
  let result = "success";
  const log = [];
  for (const [index, step] of steps.entries()) {
    if (!runs(step.if, contexts, result)) continue;
    const outputFile = join(release.root, `step-${index}.output`);
    writeFileSync(outputFile, "");
    let status = 0;
    const script = step.run ?? actionCommand(step);
    if (script !== undefined) {
      const scriptFile = join(release.root, "step.sh");
      writeFileSync(scriptFile, script);
      const [command, ...args] = shellCommand(job, step, scriptFile);
      const env = Object.entries(step.env ?? {}).map(([key, value]) => [
        key,
        interpolate(value, contexts),
      ]);
      const run = spawnSync(command, args, {
        cwd: release.root,
        encoding: "utf8",
        env: environment(release, outputFile, Object.fromEntries(env)),
      });
      status = run.status;
      log.push(`${step.name}: exit ${status}\n${run.stdout}${run.stderr}`);
    }
    const failed = status !== 0 && !evaluate(step["continue-on-error"] ?? false, contexts);
    if (failed) result = "failure";
    if (step.id !== undefined) {
      contexts.steps[step.id] = {
        outputs: readOutputs(outputFile),
        outcome: status === 0 ? "success" : "failure",
        conclusion: failed ? "failure" : "success",
      };
    }
  }
  return { result, log: log.join("\n") };
}

const contexts = (extra) => ({
  github: {
    repository: "Dr-Nikson/effect-grpc",
    event_name: "workflow_run",
    event: { workflow_run: { id: 7, head_sha: "5114f85" } },
  },
  secrets: {},
  ...extra,
});

/** The version job's steps after the changesets action, which reported `changesets`. */
function runVersionJob(release, changesets) {
  const context = contexts({
    steps: { changesets: { outputs: changesets, outcome: "success", conclusion: "success" } },
  });
  const action = versionJob.steps.findIndex((step) => step.uses?.startsWith("changesets/action@"));
  const { result, log } = runSteps(
    release,
    versionJob,
    versionJob.steps.slice(action + 1),
    context,
  );
  assert.equal(result, "success", log);
  return Object.fromEntries(
    Object.entries(versionJob.outputs).map(([name, value]) => [name, interpolate(value, context)]),
  );
}

/** The publish job, if its `if:` lets it start after a version job with these outputs. */
function runPublishJob(release, versionOutputs) {
  const needs = { "version-pr": { result: "success", outputs: versionOutputs } };
  if (!runs(publishJob.if, contexts({ needs }))) return { ran: false };
  return {
    ran: true,
    ...runSteps(release, publishJob, publishJob.steps, contexts({ needs, steps: {} })),
  };
}

/** A run of release.yml, which "Re-run all jobs" repeats. */
function releaseRun(release, changesets = NO_VERSION_PR) {
  const versionOutputs = runVersionJob(release, changesets);
  return { versionOutputs, publish: runPublishJob(release, versionOutputs) };
}

for (const { name, tagged, release, after } of tagMoves) {
  test(`${name}: a release of ${release} publishes it and leaves ${TAG} on ${after}`, (t) => {
    const registryFile = registry(t, { tagged });
    const { publish } = releaseRun(checkout(t, registryFile, library(release)));
    assert.equal(publish.result, "success", publish.log);
    const { versions, distTags } = readRegistry(registryFile);
    assert.deepEqual(
      versions[release],
      { publishedWith: setupNodeNpm },
      "setup-node's npm publishes",
    );
    assert.deepEqual(distTags, { latest, [TAG]: after });
  });
}

test("after a release, Re-run all jobs starts no publish job and changes nothing", (t) => {
  const registryFile = registry(t, { tagged: "4.0.0-alpha.0" });
  const release = checkout(t, registryFile, library("4.0.0-alpha.1"));
  assert.equal(releaseRun(release).publish.result, "success");
  const released = readRegistry(registryFile);
  assert.deepEqual(releaseRun(release).publish, { ran: false });
  assert.deepEqual(readRegistry(registryFile), released);
});

for (const [rerun, again] of [
  ["Re-run all jobs", (release) => releaseRun(release).publish],
  ["Re-run failed jobs", (release, first) => runPublishJob(release, first.versionOutputs)],
]) {
  test(`a refused tag move turns the run red, and ${rerun} moves the tag without a second publish`, (t) => {
    const registryFile = registry(t, { tagged: "4.0.0-alpha.0", allowDistTag: false });
    const release = checkout(t, registryFile, library("4.0.0-alpha.1"));
    const first = releaseRun(release);
    assert.equal(first.publish.result, "failure", first.publish.log);
    const published = readRegistry(registryFile);
    assert.equal(published.distTags[TAG], "4.0.0-alpha.0");
    updateRegistry(registryFile, { allowDistTag: true });
    const second = again(release, first);
    assert.equal(second.result, "success", second.log);
    const { versions, distTags } = readRegistry(registryFile);
    assert.deepEqual(versions, published.versions);
    assert.deepEqual(distTags, { latest, [TAG]: "4.0.0-alpha.1" });
  });
}

test("a rerun of an older release after a newer one leaves effect-v4 on the newer release", (t) => {
  const registryFile = registry(t, { tagged: "4.0.0-alpha.0", allowDistTag: false });
  const older = checkout(t, registryFile, library("4.0.0-alpha.1"));
  const failed = releaseRun(older);
  assert.equal(failed.publish.result, "failure", failed.publish.log);
  updateRegistry(registryFile, { allowDistTag: true });
  const newer = releaseRun(checkout(t, registryFile, library("4.0.0-alpha.2")));
  assert.equal(newer.publish.result, "success", newer.publish.log);
  const released = readRegistry(registryFile);
  assert.equal(released.distTags[TAG], "4.0.0-alpha.2");
  assert.deepEqual(releaseRun(older).publish, { ran: false }, "Re-run all jobs");
  const rerun = runPublishJob(older, failed.versionOutputs);
  assert.equal(rerun.result, "success", rerun.log);
  assert.deepEqual(readRegistry(registryFile).distTags, released.distTags, "Re-run failed jobs");
});

test("while a version PR is open, no publish job starts, even with effect-v4 behind the manifest", (t) => {
  const registryFile = registry(t, { tagged: "4.0.0-alpha.0", published: ["4.0.0-alpha.1"] });
  const release = checkout(t, registryFile, library("4.0.0-alpha.1"));
  assert.deepEqual(releaseRun(release, OPEN_VERSION_PR).publish, { ran: false });
  assert.equal(readRegistry(registryFile).distTags[TAG], "4.0.0-alpha.0");
  assert.equal(releaseRun(release).publish.result, "success", "without the version PR it moves");
  assert.equal(readRegistry(registryFile).distTags[TAG], "4.0.0-alpha.1");
});

/** Runs the script as the release steps do, from the checkout root, with an npm that has OIDC. */
function runScript(t, manifest, args) {
  const registryFile = registry(t, { tagged: "4.0.0-alpha.0", published: ["4.0.0-alpha.1"] });
  const release = checkout(t, registryFile, manifest);
  writeFileSync(join(release.root, "runner.json"), JSON.stringify({ npm: "11.21.0" }));
  const { status, stdout } = spawnSync(
    process.execPath,
    [".github/scripts/move-effect-dist-tag.mjs", ...args],
    { cwd: release.root, encoding: "utf8", env: environment(release, join(release.root, "out")) },
  );
  return { status, stdout, registry: readRegistry(registryFile) };
}

test("the script reports the tag as behind and moves it for the library's manifest", (t) => {
  const check = runScript(t, library("4.0.0-alpha.1"), ["--check"]);
  assert.deepEqual([check.status, check.stdout], [0, "behind=true\n"]);
  const move = runScript(t, library("4.0.0-alpha.1"), []);
  assert.equal(move.status, 0);
  assert.equal(move.registry.distTags[TAG], "4.0.0-alpha.1");
});

for (const { name, manifest } of refused) {
  test(`the version job and the publish job fail on ${name}, and npm gets no dist-tag request`, (t) => {
    for (const args of [["--check"], []]) {
      const run = runScript(t, manifest, args);
      assert.notEqual(run.status, 0, args.join(" "));
      assert.doesNotMatch(run.stdout, /behind=/);
      assert.deepEqual(run.registry.distTagRequests, []);
      assert.equal(run.registry.distTags[TAG], "4.0.0-alpha.0");
    }
  });
}
