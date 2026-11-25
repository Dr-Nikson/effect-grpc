// .github/scripts/effect-versions.test.mjs
import { dump } from "js-yaml";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { effectPackages, mismatches, pinned, supportedEffect } from "./effect-versions.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/effect-versions.json", import.meta.url), "utf8"),
);
const { cli } = fixtures;
const script = fileURLToPath(new URL("./effect-versions.mjs", import.meta.url));

const lockfileOf = (keys) => ({
  lockfileVersion: "9.0",
  packages: Object.fromEntries(keys.map((key) => [key, {}])),
});

const FAKE_NPM = [
  "#!/usr/bin/env node",
  'if (process.argv.slice(2).join(" ") !== "view effect versions --json") process.exit(2);',
  'if (process.env.NPM_STATUS === "0") console.log(process.env.NPM_VERSIONS);',
  "process.exit(Number(process.env.NPM_STATUS));",
  "",
].join("\n");

function runScript(args, { lockfile = lockfileOf(cli.installed), npmStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "effect-versions-"));
  const bin = join(dir, "bin");
  const checkout = join(dir, "checkout");
  const githubOutput = join(dir, "github-output");
  mkdirSync(bin);
  mkdirSync(join(checkout, "packages", "effect-grpc"), { recursive: true });
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(githubOutput, "");
  writeFileSync(join(checkout, "package.json"), JSON.stringify(cli.manifest));
  writeFileSync(
    join(checkout, "packages", "effect-grpc", "package.json"),
    JSON.stringify(cli.library),
  );
  writeFileSync(join(checkout, "pnpm-workspace.yaml"), dump(cli.workspace));
  writeFileSync(join(checkout, "pnpm-lock.yaml"), dump(lockfile));
  const { status, stderr } = spawnSync(process.execPath, [script, ...args], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: githubOutput,
      NPM_VERSIONS: JSON.stringify(cli.published),
      NPM_STATUS: String(npmStatus),
    },
  });
  return {
    status,
    stderr,
    output: Object.fromEntries(
      readFileSync(githubOutput, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    ),
    manifest: JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")),
  };
}

for (const {
  name,
  peers,
  catalog,
  catalogs,
  published,
  oldest,
  newest,
  refused,
} of fixtures.supported) {
  test(`the version job ${name}`, () => {
    const resolve = () =>
      supportedEffect({ peerDependencies: peers }, { catalog, catalogs }, published);
    if (refused) {
      assert.throws(resolve, (error) => error.message.includes(refused));
      return;
    }
    const ends = resolve();
    assert.deepEqual([ends.oldest, ends.newest], [oldest, newest]);
  });
}

for (const { name, version, packages, mismatched } of fixtures.lockfiles) {
  test(`the version check ${name}`, () => {
    assert.deepEqual(mismatches(effectPackages(lockfileOf(packages)), version), mismatched);
  });
}

test("the pin overrides every Effect package and keeps the overrides the repo has", () => {
  const manifest = { name: "effect-grpc", pnpm: { overrides: { semver: "7.7.2" } } };
  assert.deepEqual(pinned(manifest, ["effect", "@effect/vitest"], "4.0.7"), {
    name: "effect-grpc",
    pnpm: { overrides: { semver: "7.7.2", effect: "4.0.7", "@effect/vitest": "4.0.7" } },
  });
});

for (const version of fixtures.hostilePins) {
  test(`the pin refuses ${JSON.stringify(version)}`, () => {
    assert.throws(() => pinned({}, ["effect"], version), /Refusing to pin/);
  });
}

test("the resolve command gives the later jobs the oldest and the newest release of the peer range, whatever the lockfile and the default catalog pin", () => {
  const run = runScript(["resolve"]);
  assert.equal(run.status, 0);
  assert.deepEqual(run.output, { oldest: "4.0.7", newest: "4.1.5" });
});

test("the resolve command fails and gives the later jobs nothing when npm cannot list the releases", () => {
  const run = runScript(["resolve"], { npmStatus: 1 });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.output, {});
});

test("the pin command writes an override for every Effect package that the lockfile resolves and keeps the rest of package.json", () => {
  const run = runScript(["pin", "4.0.7"]);
  assert.equal(run.status, 0);
  assert.deepEqual(run.manifest, {
    ...cli.manifest,
    pnpm: {
      overrides: {
        semver: "7.7.2",
        effect: "4.0.7",
        "@effect/platform-node": "4.0.7",
        "@effect/platform-node-shared": "4.0.7",
      },
    },
  });
});

for (const version of fixtures.hostilePins.filter((pin) => typeof pin === "string")) {
  test(`the pin command refuses ${JSON.stringify(version)} and leaves package.json as it was`, () => {
    const run = runScript(["pin", version]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Refusing to pin/);
    assert.deepEqual(run.manifest, cli.manifest);
  });
}

test("the pin command refuses to run without a version and leaves package.json as it was", () => {
  const run = runScript(["pin"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Refusing to pin/);
  assert.deepEqual(run.manifest, cli.manifest);
});

for (const { name, version, packages, mismatched } of fixtures.lockfiles) {
  test(`the check command ${name}`, () => {
    const run = runScript(["check", version], { lockfile: lockfileOf(packages) });
    assert.equal(run.status === 0, mismatched.length === 0);
    for (const mismatch of mismatched) assert.ok(run.stderr.includes(mismatch), mismatch);
  });
}
