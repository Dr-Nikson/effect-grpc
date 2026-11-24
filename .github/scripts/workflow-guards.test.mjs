// .github/scripts/workflow-guards.test.mjs
// Evaluates the `if:` conditions of release.yml and snapshot-release.yml with GitHub's own
// expression evaluator against event payloads from fixtures. These conditions run only from the
// default branch, so this is the check that exists before a change merges.
import { load } from "js-yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const readWorkflow = (name) =>
  load(readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8"));

const release = readWorkflow("release.yml");
const snapshot = readWorkflow("snapshot-release.yml");
const events = readJson("./fixtures/workflow-events.json");
const associations = readJson("./fixtures/comment-associations.json");

/**
 * Whether GitHub runs a job or step with this `if:` for these contexts. The evaluator knows no job
 * status, so always() is true and success() and failure() follow `status`.
 *
 * @param {string | undefined} condition
 * @param {Record<string, unknown>} contexts
 * @param {"success" | "failure"} [status]
 */
function runs(condition, contexts, status = "success") {
  if (condition === undefined) return true;
  const expression = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition)?.[1] ?? condition;
  const functions = Object.entries({
    always: true,
    success: status === "success",
    failure: status === "failure",
    cancelled: false,
  }).map(([name, value]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(value),
  }));
  const ast = new Parser(
    new Lexer(expression).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const context = JSON.parse(JSON.stringify(contexts), data.reviver);
  return truthy(new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f]))).evaluate());
}

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
  // The action's outputs on master at 448c926, where only an empty changeset was pending.
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
