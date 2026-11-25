// .github/scripts/published-manifest.test.mjs
import { load } from "js-yaml";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { EFFECT_DIST_TAG } from "./move-effect-dist-tag.mjs";

const LIBRARY = fileURLToPath(new URL("../../packages/effect-grpc/", import.meta.url));
const { catalogs } = load(
  readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
);

/** The package.json that `pnpm pack` puts in the tarball, as `changeset publish` publishes it. */
function packedManifest(t) {
  const dir = mkdtempSync(join(tmpdir(), "packed-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pack = spawnSync("pnpm", ["pack", "--pack-destination", dir], {
    cwd: LIBRARY,
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = readdirSync(dir).find((file) => file.endsWith(".tgz"));
  const untar = spawnSync("tar", ["-xzf", join(dir, tarball), "-C", dir, "package/package.json"], {
    encoding: "utf8",
  });
  assert.equal(untar.status, 0, untar.stderr);
  return JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
}

test("npm installs the library next to effect and @effect/opentelemetry from 4.0.7, the first release its tests pass on, and refuses 4.0.0 to 4.0.6", (t) => {
  const { peerDependencies } = packedManifest(t);
  for (const name of ["effect", "@effect/opentelemetry"]) {
    const range = peerDependencies[name];
    for (const patch of [0, 1, 2, 3, 4, 5, 6]) {
      assert.ok(!semver.satisfies(`4.0.${patch}`, range), `${name} ${range} accepts 4.0.${patch}`);
    }
    assert.ok(semver.satisfies("4.0.7", range), `${name} ${range} refuses 4.0.7`);
    const tested = catalogs.default[name];
    assert.ok(semver.satisfies(tested, range), `${name} ${range} refuses ${tested}, which CI runs`);
  }
});

test("the dist-tag that a release moves names the Effect major of the published effect peer", (t) => {
  const { peerDependencies } = packedManifest(t);
  const major = Number(/^effect-v(\d+)$/.exec(EFFECT_DIST_TAG)?.[1]);
  assert.ok(Number.isInteger(major), EFFECT_DIST_TAG);
  assert.ok(
    semver.subset(peerDependencies.effect, `>=${major}.0.0 <${major + 1}.0.0`),
    `${EFFECT_DIST_TAG} and ${peerDependencies.effect}`,
  );
});
