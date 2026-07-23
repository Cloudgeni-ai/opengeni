import { appendFileSync } from "node:fs";
import { verifySourceAdmission } from "./check-source-admission.mjs";

export const RELEASE_AUTOMATION_CONTRACT = Object.freeze({
  apiUrl: "https://api.github.com",
  serverUrl: "https://github.com",
  repository: "Cloudgeni-ai/opengeni",
  owner: "Cloudgeni-ai",
  defaultBranch: "main",
  versionBranch: "changeset-release/main",
  releaseWorkflowPath: ".github/workflows/release.yml",
  ciWorkflowPath: ".github/workflows/ci.yml",
  ciWorkflowFile: "ci.yml",
  sourceAdmissionWorkflowPath: ".github/workflows/source-admission.yml",
  versionAuthor: Object.freeze({
    login: "github-actions[bot]",
    id: 41898282,
    type: "Bot",
  }),
  releaseApprover: Object.freeze({
    login: "jorgensandhaug",
    id: 55702375,
    type: "User",
  }),
  checks: Object.freeze({
    sourceAdmission: "Current-base source admission",
    automationCi: "Automation PR CI",
  }),
});

const shaPattern = /^[0-9a-f]{40}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const decisiveReviewStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const maximumPages = 30;
const recordsPerPage = 100;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is invalid`,
  );
  return value;
}

function assertString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  return value;
}

function assertSha(value, label) {
  invariant(
    typeof value === "string" && shaPattern.test(value),
    `${label} is not a lowercase Git SHA`,
  );
  return value;
}

function assertPositiveInteger(value, label) {
  const text = String(value ?? "");
  invariant(positiveIntegerPattern.test(text), `${label} is not a positive integer`);
  const parsed = Number(text);
  invariant(Number.isSafeInteger(parsed), `${label} is outside the safe integer range`);
  return parsed;
}

function assertTimestamp(value, label) {
  const timestamp = Date.parse(assertString(value, label));
  invariant(Number.isFinite(timestamp), `${label} is invalid`);
  return timestamp;
}

function requiredEnvironment(env, names) {
  for (const name of names) assertString(env[name], name);
}

function githubClient(fetchImpl, token) {
  invariant(typeof fetchImpl === "function", "fetch implementation is missing");
  const request = async (method, path, body) => {
    invariant(typeof path === "string" && path.startsWith("/"), "GitHub API path is invalid");
    const response = await fetchImpl(`${RELEASE_AUTOMATION_CONTRACT.apiUrl}${path}`, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "opengeni-release-pr-automation",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    invariant(
      response?.ok === true,
      `GitHub API ${method} ${path} failed with HTTP ${response?.status ?? "unknown"}`,
    );
    if (response.status === 204) return null;
    return response.json();
  };
  return {
    get: (path) => request("GET", path),
    patch: (path, body) => request("PATCH", path, body),
    post: (path, body) => request("POST", path, body),
  };
}

function assertRepository(value) {
  invariant(value?.full_name === RELEASE_AUTOMATION_CONTRACT.repository, "repository changed");
  invariant(
    value?.owner?.login === RELEASE_AUTOMATION_CONTRACT.owner &&
      value.owner.type === "Organization",
    "repository owner changed",
  );
  invariant(
    value?.default_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "default branch changed",
  );
  invariant(
    value?.archived === false && value?.disabled === false && value?.private === false,
    "repository is not an active public repository",
  );
}

function assertMainRef(value, expectedSha, label = "default branch") {
  invariant(
    value?.ref === `refs/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`,
    `${label} ref changed`,
  );
  invariant(value?.object?.type === "commit", `${label} is not a direct commit ref`);
  const actualSha = assertSha(value.object.sha, `${label} SHA`);
  invariant(actualSha === expectedSha, `${label} differs from the admitted base SHA`);
}

function assertIdentity(actual, expected, label) {
  invariant(actual?.login === expected.login, `${label} login changed`);
  invariant(actual?.id === expected.id, `${label} numeric identity changed`);
  invariant(actual?.type === expected.type, `${label} account type changed`);
}

function assertVersionPull(pull, expected) {
  const expectedNumber = expected.prNumber ?? expected.number;
  invariant(pull?.number === expectedNumber, "Version PR number changed");
  invariant(pull?.state === "open" && pull?.merged === false, "Version PR is not open");
  invariant(pull?.draft === false, "Version PR is a draft");
  assertIdentity(pull?.user, RELEASE_AUTOMATION_CONTRACT.versionAuthor, "Version PR author");
  invariant(
    pull?.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "Version PR base branch changed",
  );
  invariant(
    pull?.base?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "Version PR base repository changed",
  );
  invariant(pull?.base?.sha === expected.baseSha, "Version PR base SHA changed");
  invariant(
    pull?.head?.ref === RELEASE_AUTOMATION_CONTRACT.versionBranch,
    "Version PR head branch changed",
  );
  invariant(
    pull?.head?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "Version PR is not from the base repository",
  );
  const headSha = assertSha(pull?.head?.sha, "Version PR head SHA");
  invariant(headSha !== expected.baseSha, "Version PR head does not differ from its base");
  if (expected.headSha !== undefined)
    invariant(headSha === expected.headSha, "Version PR head SHA changed");
  invariant(
    Number.isSafeInteger(pull?.commits) && pull.commits > 0,
    "Version PR commit count is invalid",
  );
  invariant(
    Number.isSafeInteger(pull?.changed_files) && pull.changed_files > 0,
    "Version PR changed-file count is invalid",
  );
  return headSha;
}

function baseGithubContext(env, workflowPath, eventName) {
  requiredEnvironment(env, [
    "GITHUB_API_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_TOKEN",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
  ]);
  invariant(
    env.GITHUB_API_URL === RELEASE_AUTOMATION_CONTRACT.apiUrl,
    "unexpected GitHub API origin",
  );
  invariant(
    env.GITHUB_SERVER_URL === RELEASE_AUTOMATION_CONTRACT.serverUrl,
    "unexpected GitHub server origin",
  );
  invariant(
    env.GITHUB_REPOSITORY === RELEASE_AUTOMATION_CONTRACT.repository,
    "unexpected repository",
  );
  invariant(env.GITHUB_EVENT_NAME === eventName, "unexpected workflow event");
  invariant(
    env.GITHUB_REF === `refs/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`,
    "workflow is not running on the default branch ref",
  );
  invariant(
    env.GITHUB_WORKFLOW_REF ===
      `${RELEASE_AUTOMATION_CONTRACT.repository}/${workflowPath}@refs/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`,
    "workflow source is not the trusted default branch",
  );
  const sha = assertSha(env.GITHUB_SHA, "GITHUB_SHA");
  invariant(
    assertSha(env.GITHUB_WORKFLOW_SHA, "GITHUB_WORKFLOW_SHA") === sha,
    "workflow source SHA differs from its event SHA",
  );
  return { sha, token: env.GITHUB_TOKEN };
}

function releasePushContext(env) {
  const context = baseGithubContext(env, RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath, "push");
  requiredEnvironment(env, ["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID"]);
  return {
    ...context,
    runAttempt: assertPositiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
    runId: assertPositiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
  };
}

function automationInputs(env, suppliedInputs) {
  const values = suppliedInputs ?? {
    prNumber: env.AUTOMATION_PR_NUMBER,
    headSha: env.AUTOMATION_HEAD_SHA,
    baseSha: env.AUTOMATION_BASE_SHA,
    sourceRunId: env.AUTOMATION_SOURCE_RUN_ID,
    sourceRunAttempt: env.AUTOMATION_SOURCE_RUN_ATTEMPT,
  };
  const inputs = {
    prNumber: assertPositiveInteger(values.prNumber, "automation PR number"),
    headSha: assertSha(values.headSha, "automation head SHA"),
    baseSha: assertSha(values.baseSha, "automation base SHA"),
    sourceRunId: assertPositiveInteger(values.sourceRunId, "source Release run ID"),
    sourceRunAttempt: assertPositiveInteger(values.sourceRunAttempt, "source Release run attempt"),
  };
  invariant(inputs.headSha !== inputs.baseSha, "automation head SHA equals its base SHA");
  return inputs;
}

function automationCiContext(env, suppliedInputs) {
  const context = baseGithubContext(
    env,
    RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
    "workflow_dispatch",
  );
  requiredEnvironment(env, ["GITHUB_RUN_ID"]);
  const inputs = automationInputs(env, suppliedInputs);
  invariant(context.sha === inputs.baseSha, "CI workflow SHA differs from the admitted base SHA");
  return {
    ...context,
    ...inputs,
    ciRunId: assertPositiveInteger(env.GITHUB_RUN_ID, "CI run ID"),
  };
}

function repositoryPath(path) {
  return `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}${path}`;
}

async function terminalVersionIdentity(api, context) {
  const [main, pull] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
  ]);
  assertMainRef(main, context.baseSha, "terminal default branch");
  assertVersionPull(pull, context);
  return pull;
}

export async function validateVersionPrDispatch(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const context = releasePushContext(env);
  const prNumber = assertPositiveInteger(
    options.prNumber ?? env.VERSION_PR_NUMBER,
    "Version PR number",
  );
  const api = githubClient(options.fetchImpl ?? globalThis.fetch, context.token);
  const [repository, main, pull] = await Promise.all([
    api.get(repositoryPath("")),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${prNumber}`)),
  ]);
  assertRepository(repository);
  assertMainRef(main, context.sha);
  const headSha = assertVersionPull(pull, { number: prNumber, baseSha: context.sha });

  await terminalVersionIdentity(api, {
    prNumber,
    baseSha: context.sha,
    headSha,
  });
  await api.post(
    repositoryPath(`/actions/workflows/${RELEASE_AUTOMATION_CONTRACT.ciWorkflowFile}/dispatches`),
    {
      ref: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
      inputs: {
        automation_pr_number: String(prNumber),
        automation_head_sha: headSha,
        automation_base_sha: context.sha,
        source_release_run_id: String(context.runId),
        source_release_run_attempt: String(context.runAttempt),
      },
    },
  );
  logger.log(
    `Dispatched trusted CI for Version PR #${prNumber} at ${headSha} on current main ${context.sha}.`,
  );
  return { prNumber, headSha, baseSha: context.sha };
}

function assertSourceRun(run, context) {
  invariant(run?.id === context.sourceRunId, "source Release run ID changed");
  invariant(run?.run_attempt === context.sourceRunAttempt, "source Release run attempt changed");
  invariant(run?.event === "push", "source Release run was not triggered by a push");
  invariant(
    (run?.status === "in_progress" && run.conclusion === null) ||
      (run?.status === "completed" && run.conclusion === "success"),
    "source Release run is neither in progress nor successfully completed",
  );
  invariant(
    run?.path === RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath,
    "source run did not execute the Release workflow",
  );
  invariant(
    run?.head_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "source Release run branch changed",
  );
  invariant(run?.head_sha === context.baseSha, "source Release run SHA changed");
  invariant(
    run?.repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository &&
      run?.head_repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "source Release run repository changed",
  );
}

function syntheticSourceAdmissionContext(context, pull) {
  return {
    env: {
      GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
      GITHUB_BASE_REF: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_HEAD_REF: RELEASE_AUTOMATION_CONTRACT.versionBranch,
      GITHUB_REF: `refs/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`,
      GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
      GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
      GITHUB_SHA: context.baseSha,
      GITHUB_TOKEN: context.token,
      GITHUB_WORKFLOW_REF:
        `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
        `${RELEASE_AUTOMATION_CONTRACT.sourceAdmissionWorkflowPath}@refs/heads/` +
        RELEASE_AUTOMATION_CONTRACT.defaultBranch,
      GITHUB_WORKFLOW_SHA: context.baseSha,
      OPENGENI_SOURCE_ADMISSION_ACTION: "verify_current_base_head",
    },
    event: {
      action: "synchronize",
      number: context.prNumber,
      repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
      pull_request: {
        number: context.prNumber,
        state: "open",
        base: pull.base,
        head: pull.head,
      },
    },
  };
}

export async function validateVersionPrCiAdmission(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const context = automationCiContext(env, options.inputs);
  const api = githubClient(fetchImpl, context.token);
  const [repository, main, pull, sourceRun] = await Promise.all([
    api.get(repositoryPath("")),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    api.get(repositoryPath(`/actions/runs/${context.sourceRunId}`)),
  ]);
  assertRepository(repository);
  assertMainRef(main, context.baseSha);
  assertVersionPull(pull, context);
  assertSourceRun(sourceRun, context);

  const sourceContext = syntheticSourceAdmissionContext(context, pull);
  const admission = await verifySourceAdmission({
    ...sourceContext,
    fetchImpl,
    logger,
  });
  invariant(admission.baseSha === context.baseSha, "source admission returned another base SHA");
  invariant(admission.headSha === context.headSha, "source admission returned another head SHA");
  await terminalVersionIdentity(api, context);
  logger.log(`Automation dispatch admitted Version PR #${context.prNumber} at ${context.headSha}.`);
  return { ...context, admission };
}

function checkIdentity(kind, context) {
  invariant(kind === "source-admission" || kind === "automation-ci", "check kind is invalid");
  const name =
    kind === "source-admission"
      ? RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission
      : RELEASE_AUTOMATION_CONTRACT.checks.automationCi;
  return {
    name,
    externalId: `opengeni:release-automation:${kind}:v1:pr:${context.prNumber}:head:${context.headSha}`,
  };
}

async function findCheckRun(api, context, identity) {
  const matches = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const response = record(
      await api.get(
        repositoryPath(
          `/commits/${context.headSha}/check-runs?check_name=${encodeURIComponent(identity.name)}` +
            `&filter=all&per_page=${recordsPerPage}&page=${page}`,
        ),
      ),
      "check-run listing",
    );
    invariant(Array.isArray(response.check_runs), "check-run records are missing");
    for (const check of response.check_runs) {
      if (check?.external_id !== identity.externalId) continue;
      invariant(check?.head_sha === context.headSha, "existing check run is bound to another head");
      invariant(check?.app?.slug === "github-actions", "existing check run has another owner app");
      invariant(
        Number.isSafeInteger(check?.id) && check.id > 0,
        "existing check-run ID is invalid",
      );
      matches.push(check);
    }
    if (response.check_runs.length < recordsPerPage) break;
    invariant(page < maximumPages, "check-run listing exceeded its page limit");
  }
  invariant(matches.length <= 1, "multiple check runs share the idempotency marker");
  return matches[0];
}

async function upsertCheckRun(api, context, kind, state, now) {
  const identity = checkIdentity(kind, context);
  const existing = await findCheckRun(api, context, identity);
  const detailsUrl =
    `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
    `/actions/runs/${context.ciRunId}`;
  const completed = state.status === "completed";
  const body = {
    name: identity.name,
    head_sha: context.headSha,
    status: state.status,
    external_id: identity.externalId,
    details_url: detailsUrl,
    ...(completed
      ? {
          conclusion: state.conclusion,
          completed_at: now().toISOString(),
        }
      : { started_at: now().toISOString() }),
    output: {
      title: state.title,
      summary: state.summary,
    },
  };
  if (existing)
    return api.patch(repositoryPath(`/check-runs/${existing.id}`), {
      ...body,
      head_sha: undefined,
    });
  return api.post(repositoryPath("/check-runs"), body);
}

export async function beginVersionPrChecks(options = {}) {
  const env = options.env ?? process.env;
  const context = automationCiContext(env, options.inputs);
  const api = githubClient(options.fetchImpl ?? globalThis.fetch, context.token);
  await terminalVersionIdentity(api, context);
  const now = options.now ?? (() => new Date());
  await upsertCheckRun(
    api,
    context,
    "source-admission",
    {
      status: "in_progress",
      title: "Validating trusted automation source",
      summary: `Validating Version PR #${context.prNumber} at exact head ${context.headSha}.`,
    },
    now,
  );
  await upsertCheckRun(
    api,
    context,
    "automation-ci",
    {
      status: "in_progress",
      title: "Running exact-head automation CI",
      summary: `CI is running for Version PR #${context.prNumber} at exact head ${context.headSha}.`,
    },
    now,
  );
  return context;
}

export async function completeVersionPrChecks(options = {}) {
  const env = options.env ?? process.env;
  const context = automationCiContext(env, options.inputs);
  const kind = options.kind ?? env.AUTOMATION_CHECK_KIND;
  const requestedConclusion = options.conclusion ?? env.AUTOMATION_CHECK_CONCLUSION;
  invariant(
    requestedConclusion === "success" || requestedConclusion === "failure",
    "check conclusion is invalid",
  );
  const api = githubClient(options.fetchImpl ?? globalThis.fetch, context.token);
  let conclusion = requestedConclusion;
  let terminalError;
  if (conclusion === "success") {
    try {
      await terminalVersionIdentity(api, context);
    } catch (error) {
      conclusion = "failure";
      terminalError = error;
    }
  }
  const label = kind === "source-admission" ? "Source admission" : "Automation CI";
  await upsertCheckRun(
    api,
    context,
    kind,
    {
      status: "completed",
      conclusion,
      title: `${label} ${conclusion === "success" ? "passed" : "failed"}`,
      summary:
        `${label} ${conclusion === "success" ? "passed" : "failed"} for Version PR ` +
        `#${context.prNumber} at exact head ${context.headSha}.`,
    },
    options.now ?? (() => new Date()),
  );
  if (terminalError) throw terminalError;
  return { ...context, kind, conclusion };
}

async function paginatedArray(api, path, label) {
  const rows = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const value = await api.get(`${path}${separator}per_page=${recordsPerPage}&page=${page}`);
    invariant(Array.isArray(value), `${label} is invalid`);
    rows.push(...value);
    if (value.length < recordsPerPage) return rows;
  }
  throw new Error(`${label} exceeded ${maximumPages * recordsPerPage} records`);
}

function releaseApprovalContext(env, suppliedSourceSha) {
  requiredEnvironment(env, [
    "GITHUB_API_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_TOKEN",
  ]);
  invariant(
    env.GITHUB_API_URL === RELEASE_AUTOMATION_CONTRACT.apiUrl,
    "unexpected GitHub API origin",
  );
  invariant(
    env.GITHUB_SERVER_URL === RELEASE_AUTOMATION_CONTRACT.serverUrl,
    "unexpected GitHub server origin",
  );
  invariant(
    env.GITHUB_REPOSITORY === RELEASE_AUTOMATION_CONTRACT.repository,
    "unexpected repository",
  );
  invariant(env.GITHUB_EVENT_NAME === "workflow_dispatch", "unexpected workflow event");
  const sourceSha = assertSha(suppliedSourceSha ?? env.SOURCE_SHA, "release source SHA");
  invariant(
    assertSha(env.GITHUB_SHA, "GITHUB_SHA") === sourceSha,
    "dispatch ref differs from source SHA",
  );
  return { sourceSha, token: env.GITHUB_TOKEN };
}

export async function verifyApprovedMerge(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const context = releaseApprovalContext(env, options.sourceSha);
  const api = githubClient(options.fetchImpl ?? globalThis.fetch, context.token);
  const commit = await api.get(repositoryPath(`/git/commits/${context.sourceSha}`));
  invariant(commit?.sha === context.sourceSha, "release source commit changed");
  invariant(Array.isArray(commit?.parents), "release source parents are missing");
  invariant(commit.parents.length === 2, "release source is not a two-parent PR merge");
  const baseSha = assertSha(commit.parents[0]?.sha, "release merge first parent");
  const headSha = assertSha(commit.parents[1]?.sha, "release merge second parent");
  invariant(baseSha !== headSha, "release merge parents are identical");

  const pulls = await paginatedArray(
    api,
    repositoryPath(`/commits/${context.sourceSha}/pulls`),
    "associated pull requests",
  );
  invariant(pulls.length === 1, "release source is not associated with exactly one pull request");
  const pull = record(pulls[0], "associated pull request");
  invariant(pull.state === "closed", "associated pull request is not closed");
  invariant(pull.merge_commit_sha === context.sourceSha, "pull-request merge SHA changed");
  invariant(
    pull.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "pull-request base changed",
  );
  invariant(
    pull.base?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "pull-request base repository changed",
  );
  invariant(pull.base?.sha === baseSha, "pull-request base is not merge parent one");
  invariant(pull.head?.sha === headSha, "pull-request head is not merge parent two");
  const pullNumber = assertPositiveInteger(pull.number, "associated pull-request number");
  const author = record(pull.user, "pull-request author");
  assertString(author.login, "pull-request author login");
  const authorId = assertPositiveInteger(author.id, "pull-request author ID");
  invariant(author.type === "User" || author.type === "Bot", "pull-request author type is invalid");
  invariant(
    authorId !== RELEASE_AUTOMATION_CONTRACT.releaseApprover.id,
    "trusted reviewer authored the pull request",
  );
  const mergedAt = assertTimestamp(pull.merged_at, "pull-request merge timestamp");

  const reviews = await paginatedArray(
    api,
    repositoryPath(`/pulls/${pullNumber}/reviews`),
    "pull-request reviews",
  );
  const decisions = reviews
    .filter(
      (review) =>
        review?.user?.login === RELEASE_AUTOMATION_CONTRACT.releaseApprover.login &&
        review.user.id === RELEASE_AUTOMATION_CONTRACT.releaseApprover.id &&
        review.user.type === RELEASE_AUTOMATION_CONTRACT.releaseApprover.type &&
        review.commit_id === headSha &&
        decisiveReviewStates.has(review.state),
    )
    .map((review) => ({
      id: assertPositiveInteger(review.id, "trusted review ID"),
      review,
      submittedAt: assertTimestamp(review.submitted_at, "trusted review timestamp"),
    }))
    .sort((left, right) => left.submittedAt - right.submittedAt || left.id - right.id);
  invariant(decisions.length > 0, "trusted reviewer did not review the exact PR head");
  const decision = decisions.at(-1);
  invariant(
    decision.review.state === "APPROVED",
    "trusted review does not currently approve the exact head",
  );
  invariant(decision.submittedAt < mergedAt, "trusted approval was not submitted before merge");
  assertIdentity(
    decision.review.user,
    RELEASE_AUTOMATION_CONTRACT.releaseApprover,
    "trusted reviewer",
  );
  logger.log(`Verified PR #${pullNumber} exact-head approval before merge ${context.sourceSha}.`);
  return {
    sourceSha: context.sourceSha,
    baseSha,
    headSha,
    pullNumber,
    reviewId: decision.id,
  };
}

function writeOutputs(values, env) {
  const path = env.GITHUB_OUTPUT;
  if (!path) return;
  for (const [name, value] of Object.entries(values)) appendFileSync(path, `${name}=${value}\n`);
}

async function runCommand(env = process.env) {
  const command = process.argv[2];
  if (command === "dispatch-version-ci") {
    const result = await validateVersionPrDispatch({ env });
    writeOutputs(
      {
        automation_pr_number: result.prNumber,
        automation_head_sha: result.headSha,
        automation_base_sha: result.baseSha,
      },
      env,
    );
    return;
  }
  if (command === "begin-version-checks") {
    await beginVersionPrChecks({ env });
    return;
  }
  if (command === "admit-version-ci") {
    const result = await validateVersionPrCiAdmission({ env });
    writeOutputs(
      {
        automation_pr_number: result.prNumber,
        automation_head_sha: result.headSha,
        automation_base_sha: result.baseSha,
        automation_head_tree: result.admission.headTreeSha,
      },
      env,
    );
    return;
  }
  if (command === "complete-version-check") {
    await completeVersionPrChecks({ env });
    return;
  }
  if (command === "verify-approved-merge") {
    const result = await verifyApprovedMerge({ env });
    writeOutputs(
      {
        approved_pr_number: result.pullNumber,
        approved_pr_head_sha: result.headSha,
        approved_review_id: result.reviewId,
      },
      env,
    );
    return;
  }
  throw new Error(`unknown release automation command: ${command ?? "(missing)"}`);
}

if (import.meta.main) {
  runCommand().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
