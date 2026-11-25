// .github/scripts/move-effect-dist-tag.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@dr_nikson/effect-grpc";
export const EFFECT_DIST_TAG = "effect-v4";

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function distTagArguments(manifest) {
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error(
      `Expected the manifest of ${PACKAGE_NAME}, got ${JSON.stringify(manifest?.name)}`,
    );
  }
  const { version } = manifest;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Expected a semver version, got ${JSON.stringify(version)}`);
  }
  return ["dist-tag", "add", `${PACKAGE_NAME}@${version}`, EFFECT_DIST_TAG];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestPath = process.argv[2] ?? "packages/effect-grpc/package.json";
  const args = distTagArguments(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(`npm ${args.join(" ")}`);
  const result = spawnSync("npm", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
