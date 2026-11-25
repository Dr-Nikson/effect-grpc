// .github/scripts/workflow-guards.test.mjs
import { load } from "js-yaml";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import semver from "semver";

import { runs } from "./workflow-expressions.mjs";

import { EFFECT_DIST_TAG } from "./move-effect-dist-tag.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const readWorkflow = (name) =>
  load(readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8"));

const workflows = readdirSync(new URL("../workflows/", import.meta.url))
  .filter((file) => file.endsWith(".yml"))
  .map((file) => [file, readWorkflow(file)]);
const release = readWorkflow("release.yml");
const snapshot = readWorkflow("snapshot-release.yml");
const events = readJson("./fixtures/workflow-events.json");
const associations = readJson("./fixtures/comment-associations.json");

for (const { name, workflow_run, runs: expected } of events.releaseRuns) {
  test(`release.yml ${expected ? "starts" : "skips"} the version job for ${name}`, () => {
    const github = {
      repository: "Dr-Nikson/effect-grpc",
      event_name: "workflow_run",
      event: { workflow_run },
    };
    assert.equal(runs(release.jobs["version-pr"].if, { github }), expected);
  });
}

test("release.yml checks npm whenever the action opened no version PR, also when every changeset is empty", () => {
  const check = release.jobs["version-pr"].steps.find((step) => step.id === "check-unpublished").if;
  const after = (outputs) => ({ steps: { changesets: { outputs } } });
  assert.equal(
    runs(check, after({ published: "false", publishedPackages: "[]", hasChangesets: "true" })),
    true,
  );
  assert.equal(
    runs(check, after({ published: "false", publishedPackages: "[]", hasChangesets: "false" })),
    true,
  );
  assert.equal(
    runs(
      check,
      after({
        published: "false",
        publishedPackages: "[]",
        hasChangesets: "true",
        pullRequestNumber: "101",
      }),
    ),
    false,
  );
});

test("release.yml publishes only after the version job found an unpublished version", () => {
  const { needs, if: condition } = release.jobs.publish;
  assert.equal(needs, "version-pr");
  for (const [hasUnpublished, expected] of [
    ["true", true],
    ["false", false],
    ["", false],
  ]) {
    assert.equal(
      runs(condition, {
        needs: { "version-pr": { outputs: { has_unpublished: hasUnpublished } } },
      }),
      expected,
    );
  }
});

test("release.yml drops empty changesets before the publish action reads them", () => {
  const steps = release.jobs.publish.steps;
  const drop = steps.findIndex((step) =>
    step.run?.includes(".github/scripts/drop-empty-changesets.mjs"),
  );
  const action = steps.findIndex((step) => step.uses?.startsWith("changesets/action@"));
  assert.ok(drop !== -1 && drop < action);
});

const NPM_INSTALL = "npm install --global npm@";

test("release.yml moves the Effect dist-tag after the publish, with an npm that can do it with OIDC", () => {
  const steps = release.jobs.publish.steps;
  const publish = steps.findIndex((step) => step.uses?.startsWith("changesets/action@"));
  const install = steps.findIndex((step) => step.run?.startsWith(NPM_INSTALL));
  const move = steps.findIndex((step) =>
    step.run?.includes(".github/scripts/move-effect-dist-tag.mjs"),
  );
  assert.ok(publish !== -1 && publish < install && install < move);
  const npmVersion = steps[install].run.slice(NPM_INSTALL.length).trim();
  assert.ok(semver.satisfies(npmVersion, ">=11.21.0 <12.0.0 || >=12.2.0"), npmVersion);
});

test("the dist-tag that a release moves names the Effect major of the library's peer range", () => {
  const { peerDependencies } = readJson("../../packages/effect-grpc/package.json");
  assert.equal(peerDependencies.effect, "catalog:peer");
  const { catalogs } = load(
    readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
  );
  const range = catalogs.peer.effect;
  const major = /^effect-v(\d+)$/.exec(EFFECT_DIST_TAG)?.[1];
  assert.ok(major !== undefined, EFFECT_DIST_TAG);
  assert.ok(semver.subset(range, `^${major}.0.0`), `${EFFECT_DIST_TAG} and ${range}`);
});

const snapshotComment = (association) => ({
  github: {
    event_name: "issue_comment",
    event: {
      issue: {
        number: 83,
        pull_request: { url: "https://api.github.com/repos/Dr-Nikson/effect-grpc/pulls/83" },
      },
      comment: { body: "/snapshot", author_association: association },
    },
  },
});

for (const association of associations.trusted) {
  test(`a /snapshot comment from ${association} starts validation`, () => {
    assert.equal(runs(snapshot.jobs.validate.if, snapshotComment(association)), true);
  });
}

for (const association of associations.untrusted) {
  test(`a /snapshot comment from ${JSON.stringify(association)} starts no job`, () => {
    assert.equal(runs(snapshot.jobs.validate.if, snapshotComment(association)), false);
  });
}

for (const { name, github, runs: expected } of events.snapshotEvents) {
  test(`snapshot-release.yml ${expected ? "validates" : "ignores"} ${name}`, () => {
    assert.equal(runs(snapshot.jobs.validate.if, { github }), expected);
  });
}

test("every snapshot job that uses npm-publish waits for validation to allow the request", () => {
  const publishing = Object.entries(snapshot.jobs).filter(
    ([, job]) => job.environment !== undefined,
  );
  assert.deepEqual(
    publishing.map(([id]) => id),
    ["snapshot"],
  );
  const [, job] = publishing[0];
  assert.equal(job.environment.name, "npm-publish");
  assert.equal(job.needs, "validate");
  for (const kind of ["allowed", "refused", "ignored", ""]) {
    assert.equal(runs(job.if, { needs: { validate: { outputs: { kind } } } }), kind === "allowed");
  }
});

const grantsIdToken = (permissions) =>
  permissions === "write-all" || permissions?.["id-token"] === "write";

test("only the two publishing jobs can request an OIDC token, and both wait for the npm-publish approval", () => {
  const minting = [];
  for (const [file, workflow] of workflows) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!grantsIdToken(job.permissions ?? workflow.permissions)) continue;
      minting.push(`${file} ${id}`);
      assert.equal(job.environment?.name, "npm-publish", `${file} ${id}`);
    }
  }
  assert.deepEqual(minting.sort(), ["release.yml publish", "snapshot-release.yml snapshot"]);
});

test("the validate job checks out the event's own ref, so a comment runs the default branch's scripts", () => {
  const checkouts = snapshot.jobs.validate.steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.ref, undefined);
  assert.equal(checkouts[0].with.repository, undefined);
});

test("snapshot-release.yml replies on the pull request only for a comment request", () => {
  const condition = snapshot.jobs.reply.if;
  assert.equal(
    runs(condition, { needs: { validate: { outputs: { reply: "true" } } } }, "failure"),
    true,
  );
  assert.equal(
    runs(condition, { needs: { validate: { outputs: { reply: "false" } } } }, "failure"),
    false,
  );
  assert.equal(runs(condition, { needs: { validate: { outputs: {} } } }), false);
});
