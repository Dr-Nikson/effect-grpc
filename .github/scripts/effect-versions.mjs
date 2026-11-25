// .github/scripts/effect-versions.mjs
import { load } from "js-yaml";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";

// Effect releases `effect` and every `@effect/*` package at one version, the `fixed` group in
// .changeset/config.json of Effect-TS/effect-smol. The language service ships from another repo.
const OWN_VERSION_LINE = new Set(["@effect/language-service"]);

/** @param {string} name */
const releasesWithEffect = (name) =>
  (name === "effect" || name.startsWith("@effect/")) && !OWN_VERSION_LINE.has(name);

/**
 * @param {unknown} version
 * @returns {version is string}
 */
const isPlainVersion = (version) =>
  typeof version === "string" && semver.valid(version) === version;

/**
 * @typedef {{ peerDependencies?: Record<string, string> }} Manifest
 * @typedef {{ catalog?: Record<string, string>, catalogs?: Record<string, Record<string, string>> }} Workspace
 */

/**
 * @param {Manifest} library
 * @param {Workspace} workspace
 * @param {string} name
 */
function peerRange(library, workspace, name) {
  const spec = library.peerDependencies?.[name];
  if (spec === undefined) throw new Error(`The library has no ${name} peer`);
  if (!spec.startsWith("catalog:")) return spec;
  const catalog = spec.slice("catalog:".length) || "default";
  const entries =
    catalog === "default" ?
      (workspace.catalog ?? workspace.catalogs?.default)
    : workspace.catalogs?.[catalog];
  const range = entries?.[name];
  if (range === undefined) throw new Error(`The ${catalog} catalog has no ${name}`);
  return range;
}

/**
 * @param {Manifest} library
 * @param {Workspace} workspace
 * @param {unknown[]} published
 * @returns {{ range: string, oldest: string, newest: string }}
 */
export function supportedEffect(library, workspace, published) {
  const range = peerRange(library, workspace, "effect");
  const versions = published.filter(isPlainVersion);
  const oldest = semver.minSatisfying(versions, range);
  const newest = semver.maxSatisfying(versions, range);
  if (oldest === null || newest === null) {
    throw new Error(`No published effect release satisfies ${range}`);
  }
  for (const name of Object.keys(library.peerDependencies ?? {}).filter(releasesWithEffect)) {
    const peer = peerRange(library, workspace, name);
    if (!semver.satisfies(oldest, peer) || !semver.satisfies(newest, peer)) {
      throw new Error(
        `The library's ${name} peer range ${peer} must accept effect ${oldest} and ${newest}, the ends of ${range}`,
      );
    }
  }
  return { range, oldest, newest };
}

/**
 * @param {{ packages?: Record<string, unknown> }} lockfile
 * @returns {Map<string, string[]>}
 */
export function effectPackages(lockfile) {
  const found = new Map();
  for (const key of Object.keys(lockfile.packages ?? {})) {
    const at = key.indexOf("@", 1);
    const name = key.slice(0, at);
    if (releasesWithEffect(name)) found.set(name, [...(found.get(name) ?? []), key.slice(at + 1)]);
  }
  if (!found.has("effect")) {
    throw new Error(
      "The lockfile has no effect package. The keys under packages must look like effect@4.1.5.",
    );
  }
  return found;
}

/**
 * @param {Map<string, string[]>} packages
 * @param {string} version
 */
export function mismatches(packages, version) {
  return [...packages]
    .filter(([, versions]) => versions.length !== 1 || versions[0] !== version)
    .map(([name, versions]) => `${name} ${versions.join(", ")}`);
}

/**
 * @param {{ pnpm?: { overrides?: Record<string, string> } }} manifest
 * @param {Iterable<string>} names
 * @param {unknown} version
 */
export function pinned(manifest, names, version) {
  if (!isPlainVersion(version)) {
    throw new Error(`Refusing to pin Effect to ${JSON.stringify(version)}`);
  }
  const overrides = Object.fromEntries([...names].map((name) => [name, version]));
  return {
    ...manifest,
    pnpm: { ...manifest.pnpm, overrides: { ...manifest.pnpm?.overrides, ...overrides } },
  };
}

const readText = (path) => readFileSync(path, "utf8");
const readLockfile = () => load(readText("pnpm-lock.yaml"));

const commands = {
  resolve() {
    const { range, oldest, newest } = supportedEffect(
      JSON.parse(readText("packages/effect-grpc/package.json")),
      load(readText("pnpm-workspace.yaml")),
      JSON.parse(
        execFileSync("npm", ["view", "effect", "versions", "--json"], { encoding: "utf8" }),
      ),
    );
    console.log(`effect ${range} on npm: oldest ${oldest}, newest ${newest}`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `oldest=${oldest}\nnewest=${newest}\n`);
    }
  },
  /** @param {string | undefined} version */
  pin(version) {
    const names = [...effectPackages(readLockfile()).keys()];
    const manifest = pinned(JSON.parse(readText("package.json")), names, version);
    writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Pinned to ${version}: ${names.join(", ")}`);
  },
  /** @param {string | undefined} version */
  check(version) {
    const packages = effectPackages(readLockfile());
    for (const [name, versions] of packages) console.log(`${name} ${versions.join(", ")}`);
    const wrong = mismatches(packages, version);
    if (wrong.length > 0) {
      console.error(`::error::Not every Effect package is at ${version}: ${wrong.join("; ")}`);
      process.exitCode = 1;
    }
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command)) {
    throw new Error("Usage: effect-versions.mjs resolve | pin <version> | check <version>");
  }
  commands[command](version);
}
