// .github/scripts/fixtures/fake-release-tools.mjs
// Stands in for npm and pnpm in the release job tests: `node fake-release-tools.mjs npm|pnpm ...`.
// FAKE_REGISTRY names the registry's JSON file, which every run shares. FAKE_RUNNER names the job's
// JSON file, which holds the version of the npm on PATH: setup-node's npm until
// `npm install --global npm@<version>` replaces it. Facts of npm and the registry that the release
// relies on:
// - npm 11 before 11.21.0 and npm 12 before 12.2.0 cannot change a dist-tag with OIDC.
// - The registry refuses a dist-tag change while "Allow npm dist-tag" is off.
// - A dist-tag points only at a published version, and a version is published once.
// `pnpm changeset:publish` publishes, with the npm on PATH, every public workspace package whose
// version is not on the registry. Dist-tags change only through `npm dist-tag add`, and the
// registry records each such request in `distTagRequests`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";

const OIDC_DIST_TAGS = ">=11.21.0 <12.0.0 || >=12.2.0";

const registryFile = process.env.FAKE_REGISTRY;
const runnerFile = process.env.FAKE_RUNNER;
const registry = JSON.parse(readFileSync(registryFile, "utf8"));
const runner = JSON.parse(readFileSync(runnerFile, "utf8"));
const [tool, command, ...args] = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("-"));
const positionals = args.filter((arg) => !arg.startsWith("-"));

function fail(message) {
  console.error(`${tool} error ${message}`);
  process.exit(1);
}

const saveRegistry = () => writeFileSync(registryFile, JSON.stringify(registry, null, 2));

function splitSpec(spec = "") {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
}

function workspacePackages() {
  return readdirSync("packages")
    .map((dir) => join("packages", dir))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, ...JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }));
}

const npm = {
  install() {
    if (!flags.includes("--global") && !flags.includes("-g")) fail("installs only npm itself");
    const [name, version] = splitSpec(positionals.find((arg) => arg.startsWith("npm@")));
    if (name !== "npm" || semver.valid(version) === null) fail("installs only an exact npm");
    writeFileSync(runnerFile, JSON.stringify({ ...runner, npm: version }));
  },
  view() {
    const [spec, field] = positionals;
    const [name, version] = splitSpec(spec);
    if (name !== registry.name) fail(`E404 ${spec} is not in the registry`);
    if (field === "dist-tags" && version === undefined) {
      console.log(JSON.stringify(registry.distTags, null, 2));
    } else if (field === "version" && version in registry.versions) {
      console.log(version);
    } else {
      fail(`E404 ${spec} ${field} is not in the registry`);
    }
  },
  "dist-tag"() {
    const [action, spec, tag] = positionals;
    if (action !== "add") fail(`dist-tag ${action} is not modeled`);
    registry.distTagRequests.push({ spec, tag, npm: runner.npm });
    saveRegistry();
    const [name, version] = splitSpec(spec);
    if (!semver.satisfies(runner.npm, OIDC_DIST_TAGS)) {
      fail(`E401 npm ${runner.npm} sends no OIDC token for a dist-tag`);
    }
    if (!registry.allowDistTag) fail("E403 the trusted publisher cannot manage dist-tags");
    if (name !== registry.name || !(version in registry.versions)) fail(`E404 ${spec}`);
    registry.distTags[tag] = version;
    saveRegistry();
    console.log(`+${tag}: ${spec}`);
  },
  publish() {
    const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
    if (name !== registry.name) fail(`E404 ${name} is not in the registry`);
    if (version in registry.versions) fail(`E403 ${name}@${version} is already published`);
    registry.versions[version] = { publishedWith: runner.npm };
    saveRegistry();
  },
};
npm.i = npm.install;

const pnpm = {
  install() {},
  list() {
    const packages = workspacePackages().map(({ dir, name, version, private: hidden = false }) => ({
      name,
      version,
      private: hidden,
      path: dir,
    }));
    console.log(JSON.stringify(packages));
  },
  "changeset:publish"() {
    for (const { dir, name, version, private: hidden } of workspacePackages()) {
      if (hidden) continue;
      if (version in registry.versions) {
        console.log(`${name}@${version} is already published`);
        continue;
      }
      const { status } = spawnSync("npm", ["publish"], { cwd: dir, stdio: "inherit" });
      if (status !== 0) process.exit(status ?? 1);
    }
  },
};

const run = { npm, pnpm }[tool]?.[command];
if (run === undefined) fail(`${command} is not modeled`);
run();
