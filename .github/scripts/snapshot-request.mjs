// .github/scripts/snapshot-request.mjs

const TAG_GRAMMAR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TAG_MAX_LENGTH = 32;
const RELEASE_DIST_TAGS = new Set(["latest", "alpha"]);
const SEMVER_RANGE = /^v?(?:x|[0-9]+)$/;
const CI_WORKFLOW = "typescript-ci.yml";

/** @typedef {"command" | "tag" | "fork" | "ci" | "artifact"} Refusal */

/**
 * @typedef {{ kind: "ignored" }
 *   | { kind: "refused", reason: Refusal, reply: boolean }
 *   | { kind: "allowed", tag: string, sha: string, runId: number, artifact: string,
 *       prNumber: number | null, reply: boolean }} Decision
 */

/**
 * @typedef {object} SnapshotEvent
 * @property {string} eventName
 * @property {any} payload
 * @property {string} sha
 * @property {string} repository
 */

/**
 * @typedef {object} Evidence
 * @property {(prNumber: number) => Promise<{ sha: string, repository: string | null }>} pullRequestHead
 * @property {(sha: string) => Promise<{ id: number, event: string, conclusion: string | null, headSha: string }[]>} pushRuns
 * @property {(runId: number) => Promise<{ name: string, expired: boolean }[]>} artifacts
 */

/** @type {Record<Refusal, string>} */
export const REFUSAL_MESSAGES = {
  command:
    "Snapshot refused: write `/snapshot` or `/snapshot <tag>` as the first line of the comment.",
  tag:
    "Snapshot refused: a tag is 1 to 32 lowercase letters, digits and single hyphens, starts with a letter," +
    " and is not `latest`, `alpha` or a version range such as `v1`.",
  fork: "Snapshot refused: the pull request head must be a branch of this repository, not a fork.",
  ci: "Snapshot refused: this commit has no successful Typescript CI push run yet. Retry after it passes.",
  artifact:
    "Snapshot refused: the CI build artifact for this commit is missing or expired. Rerun CI, then retry.",
};

/** @param {unknown} tag */
function isValidTag(tag) {
  return (
    typeof tag === "string" &&
    tag.length <= TAG_MAX_LENGTH &&
    TAG_GRAMMAR.test(tag) &&
    !RELEASE_DIST_TAGS.has(tag) &&
    !SEMVER_RANGE.test(tag)
  );
}

/**
 * @param {unknown} body
 * @returns {"not-a-command" | "malformed" | { tag: string | undefined }}
 */
function readCommand(body) {
  const [word, ...args] = String(body ?? "")
    .split(/\r?\n/, 1)[0]
    .trim()
    .split(/[ \t]+/);
  if (word !== "/snapshot") return "not-a-command";
  if (args.length > 1) return "malformed";
  return { tag: args[0] };
}

/**
 * @param {Refusal} reason
 * @param {boolean} reply
 * @returns {Decision}
 */
const refuse = (reason, reply) => ({ kind: "refused", reason, reply });

/**
 * @param {SnapshotEvent} event
 * @param {Evidence} evidence
 * @returns {Promise<Decision>}
 */
export async function decideSnapshot({ eventName, payload, sha, repository }, evidence) {
  let tag;
  let headSha = sha;
  let prNumber = null;
  let reply = false;

  if (eventName === "workflow_dispatch") {
    tag = payload?.inputs?.tag;
  } else if (eventName === "issue_comment" && payload?.issue?.pull_request) {
    const command = readCommand(payload.comment?.body);
    if (command === "not-a-command") return { kind: "ignored" };
    reply = true;
    if (command === "malformed") return refuse("command", reply);
    prNumber = payload.issue.number;
    tag = command.tag ?? `pr-${prNumber}`;
  } else {
    return { kind: "ignored" };
  }

  if (!isValidTag(tag)) return refuse("tag", reply);

  if (prNumber !== null) {
    const head = await evidence.pullRequestHead(prNumber);
    if (head.repository?.toLowerCase() !== repository.toLowerCase()) return refuse("fork", reply);
    headSha = head.sha;
  }

  const run = (await evidence.pushRuns(headSha)).find(
    (candidate) =>
      candidate.event === "push" &&
      candidate.conclusion === "success" &&
      candidate.headSha === headSha,
  );
  if (run === undefined) return refuse("ci", reply);

  const artifact = `build-artifacts-${headSha}`;
  const artifacts = await evidence.artifacts(run.id);
  if (!artifacts.some((candidate) => candidate.name === artifact && !candidate.expired)) {
    return refuse("artifact", reply);
  }

  return { kind: "allowed", tag, sha: headSha, runId: run.id, artifact, prNumber, reply };
}

/**
 * @param {any} github
 * @param {string} owner
 * @param {string} repo
 * @returns {Evidence}
 */
function githubEvidence(github, owner, repo) {
  return {
    async pullRequestHead(prNumber) {
      const { data } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return { sha: data.head.sha, repository: data.head.repo?.full_name ?? null };
    },
    async pushRuns(sha) {
      const { data } = await github.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: CI_WORKFLOW,
        event: "push",
        head_sha: sha,
        status: "success",
        per_page: 100,
      });
      return data.workflow_runs.map((run) => ({
        id: run.id,
        event: run.event,
        conclusion: run.conclusion,
        headSha: run.head_sha,
      }));
    },
    async artifacts(runId) {
      const { data } = await github.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: runId,
        per_page: 100,
      });
      return data.artifacts.map((artifact) => ({ name: artifact.name, expired: artifact.expired }));
    },
  };
}

/** @param {{ github: any, context: any, core: any }} script */
export async function runSnapshotValidation({ github, context, core }) {
  const { owner, repo } = context.repo;
  const decision = await decideSnapshot(
    {
      eventName: context.eventName,
      payload: context.payload,
      sha: context.sha,
      repository: `${owner}/${repo}`,
    },
    githubEvidence(github, owner, repo),
  );

  core.setOutput("kind", decision.kind);
  core.setOutput("reply", String(decision.kind !== "ignored" && decision.reply));
  if (decision.kind === "allowed") {
    core.setOutput("tag", decision.tag);
    core.setOutput("sha", decision.sha);
    core.setOutput("run-id", String(decision.runId));
    core.setOutput("artifact", decision.artifact);
    core.info(
      `Snapshot allowed: tag ${decision.tag}, commit ${decision.sha}, CI run ${decision.runId}`,
    );
  } else if (decision.kind === "refused") {
    core.setOutput("message", REFUSAL_MESSAGES[decision.reason]);
    core.setFailed(REFUSAL_MESSAGES[decision.reason]);
  } else {
    core.info("Not a snapshot request; nothing to do.");
  }
}
