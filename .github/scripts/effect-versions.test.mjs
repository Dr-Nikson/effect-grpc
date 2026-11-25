// .github/scripts/effect-versions.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { effectPackages, mismatches, pinned, supportedEffect } from "./effect-versions.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/effect-versions.json", import.meta.url), "utf8"),
);

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
    const lockfile = { packages: Object.fromEntries(packages.map((key) => [key, {}])) };
    assert.deepEqual(mismatches(effectPackages(lockfile), version), mismatched);
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
