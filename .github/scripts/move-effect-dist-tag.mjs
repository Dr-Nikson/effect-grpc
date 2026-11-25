// .github/scripts/move-effect-dist-tag.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";

const PACKAGE_NAME = "@dr_nikson/effect-grpc";
const MANIFEST = "packages/effect-grpc/package.json";
export const EFFECT_DIST_TAG = "effect-v4";

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function releasedVersion(manifest) {
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error(
      `Expected the manifest of ${PACKAGE_NAME}, got ${JSON.stringify(manifest?.name)}`,
    );
  }
  const { version } = manifest;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Expected a semver version, got ${JSON.stringify(version)}`);
  }
  return version;
}

function npm(args, options) {
  const result = spawnSync("npm", args, options);
  if (result.error) throw result.error;
  return result;
}

function taggedVersion() {
  const { status, stdout } = npm(["view", PACKAGE_NAME, "dist-tags", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (status !== 0) throw new Error(`npm view ${PACKAGE_NAME} dist-tags exited ${status}`);
  return JSON.parse(stdout)[EFFECT_DIST_TAG];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  const version = releasedVersion(JSON.parse(readFileSync(MANIFEST, "utf8")));
  const tagged = taggedVersion();
  const behind = tagged === undefined || semver.lt(tagged, version);
  if (values.check) {
    console.log(`behind=${behind}`);
  } else if (!behind) {
    console.log(`${EFFECT_DIST_TAG} stays on ${tagged}, which is not older than ${version}`);
  } else {
    const args = ["dist-tag", "add", `${PACKAGE_NAME}@${version}`, EFFECT_DIST_TAG];
    console.log(`npm ${args.join(" ")}`);
    process.exit(npm(args, { stdio: "inherit" }).status ?? 1);
  }
}
