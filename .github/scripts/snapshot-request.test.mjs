// .github/scripts/snapshot-request.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { REFUSAL_MESSAGES, decideSnapshot, runSnapshotValidation } from "./snapshot-request.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const tags = fixture("snapshot-tags.json");
const scenarios = fixture("snapshot-requests.json");

const REPOSITORY = "Dr-Nikson/effect-grpc";
const HEAD = "1092b7f3ad43a293c48e61af1334444674f5148e";

const GREEN = {
  pullRequest: { sha: HEAD, repository: REPOSITORY },
  runs: [{ id: 45314327524, event: "push", conclusion: "success", headSha: HEAD }],
  artifacts: { 45314327524: [{ name: `build-artifacts-${HEAD}`, expired: false }] },
};

function recordingEvidence({ pullRequest, runs = [], artifacts = {} }) {
  const lookups = [];
  return {
    lookups,
    evidence: {
      async pullRequestHead(prNumber) {
        lookups.push(`pullRequestHead ${prNumber}`);
        return pullRequest;
      },
      async pushRuns(sha) {
        lookups.push(`pushRuns ${sha}`);
        return runs;
      },
      async artifacts(runId) {
        lookups.push(`artifacts ${runId}`);
        return artifacts[runId] ?? [];
      },
    },
  };
}

const dispatch = (tag) => ({
  eventName: "workflow_dispatch",
  sha: HEAD,
  repository: REPOSITORY,
  payload: { inputs: { tag } },
});

const comment = (body) => ({
  eventName: "issue_comment",
  sha: "448c926bb07e5bac8f41cef3f0d3d5490d663770",
  repository: REPOSITORY,
  payload: {
    action: "created",
    comment: { body, author_association: "OWNER" },
    issue: {
      number: 83,
      pull_request: { url: `https://api.github.com/repos/${REPOSITORY}/pulls/83` },
    },
  },
});

for (const tag of tags.valid) {
  test(`tag ${JSON.stringify(tag)} passes validation`, async () => {
    const { evidence } = recordingEvidence(GREEN);
    const decision = await decideSnapshot(dispatch(tag), evidence);
    assert.equal(decision.kind, "allowed");
    assert.equal(decision.tag, tag);
  });
}

for (const tag of tags.invalid) {
  test(`tag ${JSON.stringify(tag)} fails validation before any GitHub lookup`, async () => {
    const { evidence, lookups } = recordingEvidence(GREEN);
    assert.deepEqual(await decideSnapshot(dispatch(tag), evidence), {
      kind: "refused",
      reason: "tag",
      reply: false,
    });
    assert.deepEqual(lookups, []);
  });
}

for (const tag of tags.valid) {
  test(`/snapshot ${tag} on a pull request asks for tag ${JSON.stringify(tag)}`, async () => {
    const { evidence } = recordingEvidence(GREEN);
    const decision = await decideSnapshot(comment(`/snapshot ${tag}`), evidence);
    assert.equal(decision.kind, "allowed");
    assert.equal(decision.tag, tag);
  });
}

for (const tag of tags.invalid) {
  test(`/snapshot followed by ${JSON.stringify(tag)} never asks for that tag`, async () => {
    const { evidence } = recordingEvidence(GREEN);
    const decision = await decideSnapshot(comment(`/snapshot ${tag}`), evidence);
    assert.ok(!(decision.kind === "allowed" && decision.tag === tag));
  });
}

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const { evidence, lookups } = recordingEvidence(scenario);
    const decision = await decideSnapshot({ ...scenario.event, repository: REPOSITORY }, evidence);
    const { lookups: expectedLookups, ...expected } = scenario.expect;
    for (const [field, value] of Object.entries(expected))
      assert.deepEqual(decision[field], value, field);
    if (expectedLookups !== undefined) assert.equal(lookups.length, expectedLookups);
  });
}

function fakeScript(event, { pullRequest, runs, artifacts }) {
  const calls = [];
  const outputs = {};
  const failures = [];
  const github = {
    rest: {
      pulls: {
        async get(params) {
          calls.push(["pulls.get", params]);
          return {
            data: { head: { sha: pullRequest.sha, repo: { full_name: pullRequest.repository } } },
          };
        },
      },
      actions: {
        async listWorkflowRuns(params) {
          calls.push(["actions.listWorkflowRuns", params]);
          return { data: { workflow_runs: runs.map((r) => ({ ...r, head_sha: r.headSha })) } };
        },
        async listWorkflowRunArtifacts(params) {
          calls.push(["actions.listWorkflowRunArtifacts", params]);
          return { data: { artifacts: artifacts[params.run_id] ?? [] } };
        },
      },
    },
  };
  const core = {
    setOutput: (name, value) => (outputs[name] = value),
    setFailed: (message) => failures.push(message),
    info: () => {},
  };
  const context = {
    eventName: event.eventName,
    payload: event.payload,
    sha: event.sha,
    repo: { owner: "Dr-Nikson", repo: "effect-grpc" },
  };
  return { script: { github, context, core }, calls, outputs, failures };
}

test("the github-script entry point queries push runs of the CI workflow and sets the publish job's inputs", async () => {
  const { script, calls, outputs, failures } = fakeScript(comment("/snapshot"), GREEN);
  await runSnapshotValidation(script);
  assert.deepEqual(failures, []);
  assert.deepEqual(outputs, {
    kind: "allowed",
    reply: "true",
    tag: "pr-83",
    sha: HEAD,
    "run-id": "45314327524",
    artifact: `build-artifacts-${HEAD}`,
  });
  assert.deepEqual(calls[0], [
    "pulls.get",
    { owner: "Dr-Nikson", repo: "effect-grpc", pull_number: 83 },
  ]);
  assert.deepEqual(calls[1], [
    "actions.listWorkflowRuns",
    {
      owner: "Dr-Nikson",
      repo: "effect-grpc",
      workflow_id: "typescript-ci.yml",
      event: "push",
      head_sha: HEAD,
      status: "success",
      per_page: 100,
    },
  ]);
});

test("the github-script entry point fails the step with fixed text and sets no publish inputs on a refusal", async () => {
  const { script, calls, outputs, failures } = fakeScript(dispatch("Bad..Tag"), GREEN);
  await runSnapshotValidation(script);
  assert.deepEqual(failures, [REFUSAL_MESSAGES.tag]);
  assert.deepEqual(outputs, { kind: "refused", reply: "false", message: REFUSAL_MESSAGES.tag });
  assert.deepEqual(calls, []);
});
