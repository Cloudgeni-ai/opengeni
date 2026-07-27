import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  verifyHistoricalSourceAdmission,
  verifySourceAdmission,
} from "./check-source-admission.mjs";

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
  sealWorkflowPath: ".github/workflows/seal-release-head.yml",
  sourceAdmissionWorkflowPath: ".github/workflows/source-admission.yml",
  releaseHeadTagPrefix: "opengeni-release-head-",
  releaseHeadReleaseNamePrefix: "Retained OpenGeni release head ",
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
  githubActionsApp: Object.freeze({
    slug: "github-actions",
    id: 15368,
  }),
  checks: Object.freeze({
    sourceAdmission: "Current-base source admission",
    automationCi: "Automation PR CI",
    releaseHeadRetention: "Release-head retention",
    requiredSource: Object.freeze([
      "Typecheck and unit tests",
      "Deployment artifacts",
      "Workload image builds",
    ]),
  }),
});

const shaPattern = /^[0-9a-f]{40}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const decisiveReviewStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const retryableVersionProjectionErrors = new Set([
  "Version PR base SHA changed",
  "Version PR head SHA changed",
]);
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
  const request = async (method, path, body, allowedStatuses = []) => {
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
      response?.ok === true || allowedStatuses.includes(response?.status),
      `GitHub API ${method} ${path} failed with HTTP ${response?.status ?? "unknown"}`,
    );
    if (response.status === 204) return { status: response.status, value: null };
    return { status: response.status, value: await response.json() };
  };
  return {
    get: async (path) => (await request("GET", path)).value,
    getOptional: async (path) => {
      const result = await request("GET", path, undefined, [404]);
      return result.status === 404 ? null : result.value;
    },
    patch: async (path, body) => (await request("PATCH", path, body)).value,
    post: async (path, body) => (await request("POST", path, body)).value,
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

function releaseHeadTagName(headSha) {
  return `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${assertSha(
    headSha,
    "release head SHA",
  )}`;
}

function assertReleaseHeadRef(value, headSha) {
  const tag = releaseHeadTagName(headSha);
  invariant(value?.ref === `refs/tags/${tag}`, "release head evidence ref changed");
  invariant(
    value?.object?.type === "commit",
    "release head evidence ref is not a direct commit ref",
  );
  invariant(
    assertSha(value.object.sha, "release head evidence ref SHA") === headSha,
    "release head evidence ref points to another commit",
  );
  return tag;
}

async function ensureReleaseHeadRef(api, headSha) {
  const tag = releaseHeadTagName(headSha);
  const path = repositoryPath(`/git/ref/tags/${tag}`);
  const existing = await api.getOptional(path);
  if (existing === null) {
    await api.post(repositoryPath("/git/refs"), {
      ref: `refs/tags/${tag}`,
      sha: headSha,
    });
  } else {
    assertReleaseHeadRef(existing, headSha);
  }
  const terminal = await api.get(path);
  assertReleaseHeadRef(terminal, headSha);
  return { name: tag, ref: `refs/tags/${tag}`, sha: headSha };
}

function releaseHeadReleaseName(headSha) {
  return `${RELEASE_AUTOMATION_CONTRACT.releaseHeadReleaseNamePrefix}${assertSha(
    headSha,
    "release head SHA",
  )}`;
}

function assertReleaseHeadRelease(value, headSha) {
  const release = record(value, "release head immutable release");
  const id = assertPositiveInteger(release.id, "release head immutable release ID");
  const tagName = releaseHeadTagName(headSha);
  invariant(release.tag_name === tagName, "release head immutable release tag changed");
  invariant(
    release.name === releaseHeadReleaseName(headSha),
    "release head immutable release name changed",
  );
  invariant(
    release.draft === false && release.prerelease === true && release.immutable === true,
    "release head evidence is not a published immutable prerelease",
  );
  assertIdentity(
    release.author,
    RELEASE_AUTOMATION_CONTRACT.versionAuthor,
    "release head immutable release author",
  );
  const publishedAt = new Date(
    assertTimestamp(release.published_at, "release head immutable release publication time"),
  ).toISOString();
  const url =
    `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
    `/releases/tag/${tagName}`;
  invariant(release.html_url === url, "release head immutable release URL changed");
  return {
    id,
    tagName,
    name: releaseHeadReleaseName(headSha),
    immutable: true,
    draft: false,
    prerelease: true,
    authorId: RELEASE_AUTOMATION_CONTRACT.versionAuthor.id,
    authorLogin: RELEASE_AUTOMATION_CONTRACT.versionAuthor.login,
    authorType: RELEASE_AUTOMATION_CONTRACT.versionAuthor.type,
    publishedAt,
    url,
  };
}

async function ensureReleaseHeadRelease(api, headSha) {
  const tagName = releaseHeadTagName(headSha);
  const path = repositoryPath(`/releases/tags/${tagName}`);
  const existing = await api.getOptional(path);
  if (existing === null) {
    await api.post(repositoryPath("/releases"), {
      tag_name: tagName,
      name: releaseHeadReleaseName(headSha),
      body:
        `Provider-retained exact release-source head ${headSha}. ` +
        "This prerelease exists only as immutable source-retention evidence.",
      draft: false,
      prerelease: true,
      make_latest: "false",
    });
  } else {
    assertReleaseHeadRelease(existing, headSha);
  }
  return assertReleaseHeadRelease(await api.get(path), headSha);
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

function versionBranchProjection(value) {
  invariant(
    value?.ref === `refs/heads/${RELEASE_AUTOMATION_CONTRACT.versionBranch}`,
    "Version branch ref changed",
  );
  invariant(value?.object?.type === "commit", "Version branch is not a direct commit ref");
  return assertSha(value.object.sha, "Version branch SHA");
}

function versionHeadParent(value, expectedHeadSha) {
  invariant(
    assertSha(value?.sha, "Version head commit SHA") === expectedHeadSha,
    "Version head changed",
  );
  invariant(
    Array.isArray(value?.parents) && value.parents.length === 1,
    "Version head is not one commit",
  );
  return assertSha(value.parents[0]?.sha, "Version head parent SHA");
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
    workflowRunId: assertPositiveInteger(env.GITHUB_RUN_ID, "CI run ID"),
  };
}

function repositoryPath(path) {
  return `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}${path}`;
}

function repositoryApiUrl(path) {
  return `${RELEASE_AUTOMATION_CONTRACT.apiUrl}${repositoryPath(path)}`;
}

async function terminalVersionIdentity(api, context) {
  const [main, pull, versionBranch, headCommit] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.versionBranch}`)),
    api.get(repositoryPath(`/git/commits/${context.headSha}`)),
  ]);
  assertMainRef(main, context.baseSha, "terminal default branch");
  assertVersionPull(pull, context);
  invariant(
    versionBranchProjection(versionBranch) === context.headSha,
    "terminal Version branch changed",
  );
  invariant(
    versionHeadParent(headCommit, context.headSha) === context.baseSha,
    "terminal Version head parent changed",
  );
  return pull;
}

async function convergedVersionHeadSha(api, context, options = {}) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 1_000;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  invariant(
    Number.isSafeInteger(attempts) && attempts > 0,
    "Version PR projection attempts are invalid",
  );
  invariant(
    Number.isSafeInteger(delayMs) && delayMs >= 0,
    "Version PR projection delay is invalid",
  );
  invariant(typeof sleep === "function", "Version PR projection sleep is invalid");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [main, pull] = await Promise.all([
      api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
      api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    ]);
    // A moving main is never eventual-consistency lag. Fail immediately instead
    // of waiting against a source run that is no longer current.
    assertMainRef(main, context.baseSha);
    let headSha;
    try {
      headSha = assertVersionPull(pull, context);
    } catch (error) {
      const retryable =
        error instanceof Error && retryableVersionProjectionErrors.has(error.message);
      if (!retryable || attempt === attempts) throw error;
      await sleep(delayMs);
      continue;
    }

    const [versionBranch, headCommit] = await Promise.all([
      api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.versionBranch}`)),
      api.get(repositoryPath(`/git/commits/${headSha}`)),
    ]);
    const branchSha = versionBranchProjection(versionBranch);
    const parentSha = versionHeadParent(headCommit, headSha);
    if (branchSha === headSha && parentSha === context.baseSha) return headSha;
    if (attempt === attempts) {
      throw new Error(
        `Version PR #${context.prNumber} base/head topology did not converge after ${attempts} attempts`,
      );
    }
    await sleep(delayMs);
  }
  throw new Error("Version PR projection did not converge");
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
  const repository = await api.get(repositoryPath(""));
  assertRepository(repository);
  // changesets/action can finish updating the branch before GitHub's PR
  // projection reflects the new base/head pair. Wait only for otherwise valid
  // projection/topology drift; every identity or ownership mismatch fails fast.
  const headSha = await convergedVersionHeadSha(
    api,
    { prNumber, baseSha: context.sha },
    {
      attempts: options.projectionAttempts,
      delayMs: options.projectionDelayMs,
      sleep: options.projectionSleep,
    },
  );

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
      GITHUB_HEAD_REF: assertString(pull?.head?.ref, "pull-request head branch"),
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

function releaseHeadSealInputs(env, suppliedInputs) {
  const values = suppliedInputs ?? {
    prNumber: env.RELEASE_HEAD_PR_NUMBER,
    baseSha: env.RELEASE_HEAD_BASE_SHA,
    headSha: env.RELEASE_HEAD_SHA,
  };
  const inputs = {
    prNumber: assertPositiveInteger(values.prNumber, "release-head PR number"),
    baseSha: assertSha(values.baseSha, "release-head base SHA"),
    headSha: assertSha(values.headSha, "release-head SHA"),
  };
  invariant(inputs.headSha !== inputs.baseSha, "release head SHA equals its base SHA");
  return inputs;
}

function releaseHeadSealContext(env, suppliedInputs) {
  const github = baseGithubContext(
    env,
    RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath,
    "workflow_dispatch",
  );
  requiredEnvironment(env, ["GITHUB_RUN_ID"]);
  const inputs = releaseHeadSealInputs(env, suppliedInputs);
  invariant(github.sha === inputs.baseSha, "release-head workflow SHA differs from its base SHA");
  return {
    ...github,
    ...inputs,
    workflowRunId: assertPositiveInteger(env.GITHUB_RUN_ID, "seal workflow run ID"),
  };
}

function assertOpenReleasePull(pull, context) {
  invariant(pull?.number === context.prNumber, "release-head pull-request number changed");
  invariant(
    pull?.state === "open" && pull?.merged === false,
    "release-head pull request is not open",
  );
  invariant(pull?.draft === false, "release-head pull request is a draft");
  invariant(
    pull?.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch &&
      pull.base.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository &&
      pull.base.sha === context.baseSha,
    "release-head pull-request base changed",
  );
  invariant(pull?.head?.sha === context.headSha, "release-head pull-request head changed");
  assertString(pull?.head?.ref, "release-head pull-request head branch");
  assertString(pull?.head?.repo?.full_name, "release-head pull-request head repository");
}

function releaseHeadRecoveryContext(env, suppliedInputs) {
  const github = baseGithubContext(
    env,
    RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath,
    "workflow_dispatch",
  );
  requiredEnvironment(env, ["GITHUB_RUN_ID"]);
  const values = suppliedInputs ?? {
    prNumber: env.RELEASE_HEAD_PR_NUMBER,
    baseSha: env.RELEASE_HEAD_BASE_SHA,
    headSha: env.RELEASE_HEAD_SHA,
    sourceSha: env.RELEASE_HEAD_MERGED_SOURCE_SHA,
  };
  const context = {
    ...github,
    prNumber: assertPositiveInteger(values.prNumber, "release-head PR number"),
    baseSha: assertSha(values.baseSha, "release-head base SHA"),
    headSha: assertSha(values.headSha, "release-head SHA"),
    sourceSha: assertSha(values.sourceSha, "release-head merged source SHA"),
    workflowRunId: assertPositiveInteger(env.GITHUB_RUN_ID, "seal workflow run ID"),
  };
  invariant(context.headSha !== context.baseSha, "release head SHA equals its base SHA");
  invariant(
    context.sourceSha !== context.baseSha && context.sourceSha !== context.headSha,
    "merged source SHA is not distinct from the reviewed base and head",
  );
  return context;
}

function assertRecoveryReleasePull(pull, context) {
  const identity = assertMergedPull(pull, {
    pullNumber: context.prNumber,
    sourceSha: context.sourceSha,
  });
  invariant(identity.baseSha === context.baseSha, "release-head recovery base SHA changed");
  invariant(identity.headSha === context.headSha, "release-head recovery head SHA changed");
  assertIdentity(
    pull?.user,
    RELEASE_AUTOMATION_CONTRACT.versionAuthor,
    "release-head recovery pull-request author",
  );
  invariant(
    pull?.head?.ref === RELEASE_AUTOMATION_CONTRACT.versionBranch &&
      pull.head.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "release-head recovery pull-request head branch changed",
  );
  return identity;
}

async function assertSourceAncestorOfCurrentMain(api, sourceSha, currentMainSha) {
  if (sourceSha === currentMainSha) return;
  const comparison = await api.get(repositoryPath(`/compare/${sourceSha}...${currentMainSha}`));
  invariant(comparison?.status === "ahead", "current main is not ahead of the merged source");
  invariant(
    comparison?.base_commit?.sha === sourceSha && comparison?.merge_base_commit?.sha === sourceSha,
    "current main does not retain the merged source as its exact ancestor",
  );
  invariant(comparison?.behind_by === 0, "current main is behind the merged source");
  invariant(
    Number.isSafeInteger(comparison?.ahead_by) && comparison.ahead_by > 0,
    "current main ancestry distance is invalid",
  );
}

async function readExistingReleaseHeadEvidence(api, headSha) {
  const name = releaseHeadTagName(headSha);
  const ref = `refs/tags/${name}`;
  const retainedName = assertReleaseHeadRef(
    await api.get(repositoryPath(`/git/ref/tags/${name}`)),
    headSha,
  );
  const release = assertReleaseHeadRelease(
    await api.get(repositoryPath(`/releases/tags/${name}`)),
    headSha,
  );
  return {
    releaseHead: { name: retainedName, ref, sha: headSha },
    releaseHeadRelease: release,
  };
}

export async function recoverReleaseHeadEvidence(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const context = releaseHeadRecoveryContext(env, options.inputs);
  const api = githubClient(fetchImpl, context.token);
  const [repository, main, pull] = await Promise.all([
    api.get(repositoryPath("")),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
  ]);
  assertRepository(repository);
  assertMainRef(main, context.sha, "release-head recovery default branch");
  const pullIdentity = assertRecoveryReleasePull(pull, context);
  const [source, head, timeline] = await Promise.all([
    api
      .get(repositoryPath(`/git/commits/${context.sourceSha}`))
      .then((value) => assertCommit(value, context.sourceSha, "release-head merged source")),
    api
      .get(repositoryPath(`/git/commits/${context.headSha}`))
      .then((value) => assertCommit(value, context.headSha, "release-head reviewed head")),
    paginatedArray(
      api,
      repositoryPath(`/issues/${context.prNumber}/timeline`),
      "release-head pull-request timeline",
    ),
  ]);
  invariant(
    source.treeSha === head.treeSha,
    "release-head merged source tree differs from the reviewed head",
  );
  assertProviderMergeEvent(timeline, context.sourceSha, pullIdentity);
  const mergeMethod = await classifyMergeOutcome(api, source, pullIdentity);
  await assertSourceAncestorOfCurrentMain(api, context.sourceSha, context.sha);
  const historicalAdmission = await verifyHistoricalSourceAdmission({
    number: context.prNumber,
    baseSha: context.baseSha,
    headSha: context.headSha,
    headRef: pull.head.ref,
    headRepository: pull.head.repo.full_name,
    token: context.token,
    fetchImpl,
    logger,
  });
  const { releaseHead, releaseHeadRelease } = await readExistingReleaseHeadEvidence(
    api,
    context.headSha,
  );
  const [preMutationMain, preMutationPull, preMutationEvidence] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    readExistingReleaseHeadEvidence(api, context.headSha),
  ]);
  assertMainRef(preMutationMain, context.sha, "pre-mutation release-head recovery default branch");
  assertRecoveryReleasePull(preMutationPull, context);
  invariant(
    JSON.stringify(preMutationEvidence.releaseHead) === JSON.stringify(releaseHead) &&
      JSON.stringify(preMutationEvidence.releaseHeadRelease) === JSON.stringify(releaseHeadRelease),
    "release head evidence moved before recovery mutation",
  );

  const now = options.now ?? (() => new Date());
  const checkContext = { ...context, releaseHeadRelease };
  const sourceChecks = (await paginatedCheckRuns(api, context.headSha)).filter(
    (check) => check?.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
  );
  if (sourceChecks.length === 0) {
    await upsertCheckRun(
      api,
      checkContext,
      "source-admission",
      {
        status: "in_progress",
        title: "Recovering exact historical source admission",
        summary:
          `Reconstructing base ${context.baseSha} to head ${context.headSha}; ` +
          `manifest ${historicalAdmission.manifestSha256}.`,
      },
      now,
    );
    await upsertCheckRun(
      api,
      checkContext,
      "source-admission",
      {
        status: "completed",
        conclusion: "success",
        title: "Historical source admission recovered",
        summary:
          `PR #${context.prNumber} exact base/head tree delta is provider-complete; ` +
          `manifest ${historicalAdmission.manifestSha256}.`,
      },
      now,
    );
  }
  const sourceAdmission = assertSuccessfulCheck(
    await paginatedCheckRuns(api, context.headSha),
    RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    context.headSha,
  );
  await upsertCheckRun(
    api,
    checkContext,
    "release-head-retention",
    {
      status: "in_progress",
      title: "Recovering immutable release-head retention evidence",
      summary:
        `Recovering the provider check for retained head ${context.headSha} ` +
        `from merged source ${context.sourceSha}.`,
    },
    now,
  );

  const [terminalMain, terminalPull, terminalEvidence] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    readExistingReleaseHeadEvidence(api, context.headSha),
  ]);
  assertMainRef(terminalMain, context.sha, "terminal release-head recovery default branch");
  assertRecoveryReleasePull(terminalPull, context);
  invariant(
    JSON.stringify(terminalEvidence.releaseHead) === JSON.stringify(releaseHead),
    "release head ref moved during recovery",
  );
  invariant(
    JSON.stringify(terminalEvidence.releaseHeadRelease) === JSON.stringify(releaseHeadRelease),
    "release head immutable release moved during recovery",
  );
  await upsertCheckRun(
    api,
    checkContext,
    "release-head-retention",
    {
      status: "completed",
      conclusion: "success",
      title: "Release head retention evidence recovered",
      summary:
        `PR #${context.prNumber} exact head ${context.headSha} remains retained at ` +
        `${releaseHead.ref} by immutable prerelease ${releaseHeadRelease.id}; ` +
        `the accepted merge source is ${context.sourceSha}.`,
    },
    now,
  );
  logger.log(
    `Recovered release-head retention check for ${context.headSha} ` +
      `from merged source ${context.sourceSha}.`,
  );
  return {
    ...context,
    mergeMethod,
    sourceAdmission,
    releaseHead,
    releaseHeadRelease,
  };
}

export async function sealReleaseHeadEvidence(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const context = releaseHeadSealContext(env, options.inputs);
  const api = githubClient(fetchImpl, context.token);
  const [repository, main, pull] = await Promise.all([
    api.get(repositoryPath("")),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
  ]);
  assertRepository(repository);
  assertMainRef(main, context.baseSha, "release-head default branch");
  assertOpenReleasePull(pull, context);

  const admission = await verifySourceAdmission({
    ...syntheticSourceAdmissionContext(context, pull),
    fetchImpl,
    logger,
  });
  invariant(admission.baseSha === context.baseSha, "source admission returned another base SHA");
  invariant(admission.headSha === context.headSha, "source admission returned another head SHA");
  const sourceAdmission = assertSuccessfulCheck(
    await paginatedCheckRuns(api, context.headSha),
    RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    context.headSha,
  );
  const releaseHead = await ensureReleaseHeadRef(api, context.headSha);
  const releaseHeadRelease = await ensureReleaseHeadRelease(api, context.headSha);

  const now = options.now ?? (() => new Date());
  await upsertCheckRun(
    api,
    { ...context, releaseHeadRelease },
    "release-head-retention",
    {
      status: "in_progress",
      title: "Verifying immutable release-head retention",
      summary: `Verifying retained release head ${context.headSha} for PR #${context.prNumber}.`,
    },
    now,
  );
  const [terminalMain, terminalPull] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
  ]);
  assertMainRef(terminalMain, context.baseSha, "terminal release-head default branch");
  assertOpenReleasePull(terminalPull, context);
  const terminalReleaseHeadName = assertReleaseHeadRef(
    await api.get(repositoryPath(`/git/ref/tags/${releaseHead.name}`)),
    context.headSha,
  );
  const terminalReleaseHeadRelease = assertReleaseHeadRelease(
    await api.get(repositoryPath(`/releases/tags/${releaseHead.name}`)),
    context.headSha,
  );
  const terminalReleaseHead = {
    name: terminalReleaseHeadName,
    ref: `refs/tags/${terminalReleaseHeadName}`,
    sha: context.headSha,
  };
  invariant(
    JSON.stringify(terminalReleaseHeadRelease) === JSON.stringify(releaseHeadRelease),
    "release head immutable release moved during sealing",
  );
  invariant(
    JSON.stringify(terminalReleaseHead) === JSON.stringify(releaseHead),
    "release head ref moved during sealing",
  );
  await upsertCheckRun(
    api,
    { ...context, releaseHeadRelease: terminalReleaseHeadRelease },
    "release-head-retention",
    {
      status: "completed",
      conclusion: "success",
      title: "Release head retained immutably",
      summary:
        `PR #${context.prNumber} exact head ${context.headSha} is retained at ${releaseHead.ref} ` +
        `by immutable prerelease ${releaseHeadRelease.id}.`,
    },
    now,
  );
  logger.log(
    `Sealed release head ${context.headSha} for PR #${context.prNumber} at ${releaseHead.ref}.`,
  );
  return {
    ...context,
    admission,
    sourceAdmission,
    releaseHead,
    releaseHeadRelease,
  };
}

function checkIdentity(kind, context) {
  invariant(
    kind === "source-admission" || kind === "automation-ci" || kind === "release-head-retention",
    "check kind is invalid",
  );
  const name =
    kind === "source-admission"
      ? RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission
      : kind === "automation-ci"
        ? RELEASE_AUTOMATION_CONTRACT.checks.automationCi
        : RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention;
  const retentionIdentity =
    kind === "release-head-retention"
      ? `:release-sha256:${canonicalSha256(
          record(context.releaseHeadRelease, "release head immutable release check identity"),
        )}`
      : "";
  return {
    name,
    exclusive: kind === "release-head-retention",
    externalId:
      `opengeni:release-automation:${kind}:${kind === "release-head-retention" ? "v2" : "v1"}:` +
      `pr:${context.prNumber}:head:${context.headSha}${retentionIdentity}`,
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
      if (check?.external_id !== identity.externalId) {
        if (!identity.exclusive) continue;
        invariant(
          check?.head_sha === context.headSha,
          "conflicting check run is bound to another head",
        );
        assertGitHubActionsApp(check?.app, "conflicting check run");
        throw new Error("existing check run conflicts with the exact idempotency identity");
      }
      invariant(check?.head_sha === context.headSha, "existing check run is bound to another head");
      assertGitHubActionsApp(check?.app, "existing check run");
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
    `/actions/runs/${context.workflowRunId}`;
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
  const releaseHead = await ensureReleaseHeadRef(api, context.headSha);
  const releaseHeadRelease = await ensureReleaseHeadRelease(api, context.headSha);
  await terminalVersionIdentity(api, context);
  const now = options.now ?? (() => new Date());
  await upsertCheckRun(
    api,
    { ...context, releaseHeadRelease },
    "release-head-retention",
    {
      status: "completed",
      conclusion: "success",
      title: "Release head retained immutably",
      summary:
        `Version PR #${context.prNumber} exact head ${context.headSha} is retained at ` +
        `${releaseHead.ref} by immutable prerelease ${releaseHeadRelease.id}.`,
    },
    now,
  );
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
  return { ...context, releaseHead, releaseHeadRelease };
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

async function paginatedCheckRuns(api, sha) {
  const rows = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const value = await api.get(
      repositoryPath(
        `/commits/${sha}/check-runs?filter=all&per_page=${recordsPerPage}&page=${page}`,
      ),
    );
    invariant(Array.isArray(value?.check_runs), "check-run listing is invalid");
    rows.push(...value.check_runs);
    if (value.check_runs.length < recordsPerPage) return rows;
  }
  throw new Error(`check-run listing exceeded ${maximumPages * recordsPerPage} records`);
}

function assertGitHubActionsApp(app, label) {
  invariant(
    app?.slug === RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug &&
      app?.id === RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
    `${label} is not owned by the official GitHub Actions app`,
  );
}

function assertSuccessfulCheck(checks, name, sha) {
  const selected = checks.filter((check) => check?.name === name);
  invariant(selected.length === 1, `${name} is not represented by exactly one check run on ${sha}`);
  const check = selected[0];
  invariant(check?.head_sha === sha, `${name} is bound to another commit`);
  assertGitHubActionsApp(check?.app, name);
  invariant(
    check.status === "completed" && check.conclusion === "success",
    `${name} did not complete successfully`,
  );
  return Object.freeze({
    name,
    appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
    appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
  });
}

function assertCommit(value, expectedSha, label) {
  invariant(value?.sha === expectedSha, `${label} identity changed`);
  const treeSha = assertSha(value?.tree?.sha, `${label} tree SHA`);
  invariant(Array.isArray(value?.parents), `${label} parents are missing`);
  const parents = value.parents.map((parent, index) =>
    assertSha(parent?.sha, `${label} parent ${index}`),
  );
  return { sha: expectedSha, treeSha, parents };
}

function assertMergedPull(value, expected) {
  invariant(value?.number === expected.pullNumber, "associated pull-request number changed");
  invariant(
    value?.state === "closed" && value?.merged === true,
    "associated pull request is not merged",
  );
  invariant(value?.merge_commit_sha === expected.sourceSha, "pull-request merge SHA changed");
  invariant(
    value?.html_url ===
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}/pull/${expected.pullNumber}`,
    "pull-request URL changed",
  );
  invariant(
    value?.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "pull-request base changed",
  );
  invariant(
    value?.base?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "pull-request base repository changed",
  );
  const baseSha = assertSha(value?.base?.sha, "pull-request base SHA");
  const headSha = assertSha(value?.head?.sha, "pull-request head SHA");
  invariant(baseSha !== headSha, "pull-request base and head are identical");
  invariant(
    Number.isSafeInteger(value?.commits) && value.commits > 0 && value.commits <= 250,
    "pull-request commit count is invalid",
  );
  invariant(
    Array.isArray(value?.requested_reviewers),
    "pull-request requested reviewers are missing",
  );
  const mergedAt = assertTimestamp(value?.merged_at, "pull-request merge timestamp");
  const author = record(value?.user, "pull-request author");
  assertString(author.login, "pull-request author login");
  assertPositiveInteger(author.id, "pull-request author ID");
  invariant(author.type === "User" || author.type === "Bot", "pull-request author type is invalid");
  const merger = record(value?.merged_by, "pull-request merge actor");
  assertString(merger.login, "pull-request merge actor login");
  assertPositiveInteger(merger.id, "pull-request merge actor ID");
  invariant(
    merger.type === "User" || merger.type === "Bot",
    "pull-request merge actor type is invalid",
  );
  return { baseSha, headSha, mergedAt, author, merger, commitCount: value.commits };
}

function assertProviderMergeEvent(events, sourceSha, pullIdentity) {
  const matching = events.filter(
    (event) => event?.event === "merged" && event?.commit_id === sourceSha,
  );
  invariant(
    matching.length === 1,
    "release source is not represented by exactly one provider merge event",
  );
  const event = record(matching[0], "provider merge event");
  invariant(
    event.commit_url === repositoryApiUrl(`/commits/${sourceSha}`),
    "provider merge event commit URL changed",
  );
  invariant(
    assertTimestamp(event.created_at, "provider merge event timestamp") === pullIdentity.mergedAt,
    "provider merge event timestamp differs from pull-request merge time",
  );
  assertIdentity(event.actor, pullIdentity.merger, "provider merge actor");
  assertString(event.node_id, "provider merge event node ID");
  const eventId = assertPositiveInteger(event.id, "provider merge event ID");
  invariant(
    event.url === repositoryApiUrl(`/issues/events/${eventId}`),
    "provider merge event URL changed",
  );
}

function exactHeadReviewArtifact(baseSha, headSha) {
  return {
    version: 3,
    kind: "opengeni-exact-head-release-review",
    repository: RELEASE_AUTOMATION_CONTRACT.repository,
    reviewedBaseSha: baseSha,
    reviewedHeadSha: headSha,
    reviewerLogin: RELEASE_AUTOMATION_CONTRACT.releaseApprover.login,
    reviewProfile: "exact-head-maintainer-v1",
    verdict: "PASS",
  };
}

function canonicalSha256(value) {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function verifyAdminPassBody(body, artifact) {
  const match =
    /^<!-- opengeni-exact-head-release-review:v3 -->\n\n?```json\n([\s\S]+)\n```\s*$/.exec(body);
  invariant(match !== null, "single-maintainer admin PASS body is not canonical");
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new Error("single-maintainer admin PASS body is not valid JSON");
  }
  invariant(
    JSON.stringify(parsed) === JSON.stringify(artifact),
    "single-maintainer admin PASS does not bind the exact base/head/reviewer",
  );
  invariant(
    body ===
      `<!-- opengeni-exact-head-release-review:v3 -->\n\n\u0060\u0060\u0060json\n${JSON.stringify(artifact, null, 2)}\n\u0060\u0060\u0060`,
    "single-maintainer admin PASS body is not canonical",
  );
  return canonicalSha256(artifact);
}

function sameProviderReview(left, right) {
  return (
    left?.id === right?.id &&
    left?.state === right?.state &&
    left?.commit_id === right?.commit_id &&
    left?.html_url === right?.html_url &&
    left?.submitted_at === right?.submitted_at &&
    left?.body === right?.body &&
    left?.user?.login === right?.user?.login &&
    left?.user?.id === right?.user?.id &&
    left?.user?.type === right?.user?.type
  );
}

function validateLinearCompare(value, baseSha, sourceSha, expectedCommitCount) {
  invariant(
    value?.status === "ahead",
    "rewritten release source is not strictly ahead of its PR base",
  );
  invariant(value?.base_commit?.sha === baseSha, "compare response base commit changed");
  invariant(value?.merge_base_commit?.sha === baseSha, "compare response merge base changed");
  invariant(value?.behind_by === 0, "rewritten release source is behind its PR base");
  invariant(
    value?.ahead_by === expectedCommitCount && value?.total_commits === expectedCommitCount,
    "rewritten release source commit count differs from provider PR evidence",
  );
  invariant(
    Array.isArray(value?.commits) && value.commits.length === expectedCommitCount,
    "compare response does not contain the complete rewritten commit range",
  );
  let parent = baseSha;
  for (const [index, commit] of value.commits.entries()) {
    invariant(
      Array.isArray(commit?.parents) && commit.parents.length === 1,
      "rewritten release range is not linear",
    );
    invariant(commit.parents[0]?.sha === parent, "rewritten release range has a discontinuity");
    parent = assertSha(commit?.sha, `rewritten release commit ${index}`);
  }
  invariant(parent === sourceSha, "rewritten release range does not terminate at the source SHA");
}

async function classifyMergeOutcome(api, source, pullIdentity) {
  const exactMerge =
    source.parents.length === 2 &&
    source.parents[0] === pullIdentity.baseSha &&
    source.parents[1] === pullIdentity.headSha;
  if (exactMerge) return "merge";

  const compare = await api.get(repositoryPath(`/compare/${pullIdentity.baseSha}...${source.sha}`));
  const sourceCommitCount = Number(compare?.ahead_by);
  validateLinearCompare(compare, pullIdentity.baseSha, source.sha, sourceCommitCount);
  invariant(
    sourceCommitCount === 1 || sourceCommitCount === pullIdentity.commitCount,
    "rewritten release source is neither an exact squash nor an exact rebase",
  );
  if (sourceCommitCount === 1) {
    invariant(
      source.parents.length === 1 && source.parents[0] === pullIdentity.baseSha,
      "squashed release source is not one commit on its exact PR base",
    );
    return pullIdentity.commitCount === 1 ? "single-commit-squash-or-rebase" : "squash";
  }
  invariant(sourceCommitCount > 1, "rebased release source is empty");
  return "rebase";
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
  const initialMain = await api.get(repositoryPath("/git/ref/heads/main"));
  assertMainRef(initialMain, context.sourceSha, "initial release main");
  const source = assertCommit(
    await api.get(repositoryPath(`/git/commits/${context.sourceSha}`)),
    context.sourceSha,
    "release source commit",
  );

  const pulls = await paginatedArray(
    api,
    repositoryPath(`/commits/${context.sourceSha}/pulls`),
    "associated pull requests",
  );
  invariant(pulls.length === 1, "release source is not associated with exactly one pull request");
  const associatedPull = record(pulls[0], "associated pull request");
  const pullNumber = assertPositiveInteger(associatedPull.number, "associated pull-request number");
  invariant(
    associatedPull.merge_commit_sha === context.sourceSha,
    "associated pull summary merge SHA changed",
  );
  const pull = record(await api.get(repositoryPath(`/pulls/${pullNumber}`)), "pull-request detail");
  const pullIdentity = assertMergedPull(pull, { pullNumber, sourceSha: context.sourceSha });
  invariant(
    associatedPull.base?.sha === pullIdentity.baseSha &&
      associatedPull.head?.sha === pullIdentity.headSha,
    "associated pull summary differs from pull-request detail",
  );
  const timeline = await paginatedArray(
    api,
    repositoryPath(`/issues/${pullNumber}/timeline`),
    "pull-request timeline",
  );
  assertProviderMergeEvent(timeline, context.sourceSha, pullIdentity);
  const [base, head] = await Promise.all([
    api
      .get(repositoryPath(`/git/commits/${pullIdentity.baseSha}`))
      .then((value) => assertCommit(value, pullIdentity.baseSha, "reviewed base commit")),
    api
      .get(repositoryPath(`/git/commits/${pullIdentity.headSha}`))
      .then((value) => assertCommit(value, pullIdentity.headSha, "reviewed head commit")),
  ]);
  invariant(
    source.treeSha === head.treeSha,
    "release source tree differs from the exact reviewed head",
  );
  const mergeMethod = await classifyMergeOutcome(api, source, pullIdentity);

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
        review.commit_id === pullIdentity.headSha &&
        (decisiveReviewStates.has(review.state) ||
          (review.state === "COMMENTED" &&
            review.body?.startsWith("<!-- opengeni-exact-head-release-review:v3 -->"))),
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
    decision.submittedAt <= pullIdentity.mergedAt,
    "trusted approval was not submitted before merge",
  );
  assertIdentity(
    decision.review.user,
    RELEASE_AUTOMATION_CONTRACT.releaseApprover,
    "trusted reviewer",
  );
  const reviewUrl =
    `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
    `/pull/${pullNumber}#pullrequestreview-${decision.id}`;
  invariant(decision.review.html_url === reviewUrl, "trusted review URL changed");
  const reviewDetail = await api.get(repositoryPath(`/pulls/${pullNumber}/reviews/${decision.id}`));
  invariant(
    sameProviderReview(decision.review, reviewDetail),
    "trusted review detail differs from provider review history",
  );
  invariant(
    !pull.requested_reviewers.some(
      (candidate) =>
        candidate?.login?.toLowerCase() ===
        RELEASE_AUTOMATION_CONTRACT.releaseApprover.login.toLowerCase(),
    ),
    "trusted review is no longer effective because review was re-requested",
  );

  let reviewType;
  let reviewEvidenceSha256;
  if (decision.review.state === "APPROVED") {
    invariant(
      pullIdentity.author.id !== RELEASE_AUTOMATION_CONTRACT.releaseApprover.id,
      "trusted reviewer authored the independently approved pull request",
    );
    reviewType = "independent-approval";
    reviewEvidenceSha256 = canonicalSha256({
      version: 1,
      repository: RELEASE_AUTOMATION_CONTRACT.repository,
      pullRequestNumber: pullNumber,
      reviewedBaseSha: pullIdentity.baseSha,
      reviewedHeadSha: pullIdentity.headSha,
      reviewerLogin: RELEASE_AUTOMATION_CONTRACT.releaseApprover.login,
      reviewId: decision.id,
      verdict: "APPROVED",
    });
  } else {
    invariant(
      decision.review.state === "COMMENTED" &&
        pullIdentity.author.id === RELEASE_AUTOMATION_CONTRACT.releaseApprover.id &&
        pullIdentity.merger.id === RELEASE_AUTOMATION_CONTRACT.releaseApprover.id &&
        pullIdentity.author.type === "User" &&
        pullIdentity.merger.type === "User",
      "trusted review is neither independent approval nor a provider-bound single-maintainer admin PASS",
    );
    reviewType = "single-maintainer-admin-pass";
    reviewEvidenceSha256 = verifyAdminPassBody(
      decision.review.body ?? "",
      exactHeadReviewArtifact(pullIdentity.baseSha, pullIdentity.headSha),
    );
  }

  const releaseHeadTag = releaseHeadTagName(pullIdentity.headSha);
  const [headChecks, sourceChecks, releaseHeadRef, releaseHeadReleaseValue] = await Promise.all([
    paginatedCheckRuns(api, pullIdentity.headSha),
    paginatedCheckRuns(api, context.sourceSha),
    api.get(repositoryPath(`/git/ref/tags/${releaseHeadTag}`)),
    api.get(repositoryPath(`/releases/tags/${releaseHeadTag}`)),
  ]);
  assertReleaseHeadRef(releaseHeadRef, pullIdentity.headSha);
  const releaseHeadRelease = assertReleaseHeadRelease(
    releaseHeadReleaseValue,
    pullIdentity.headSha,
  );
  const sourceAdmission = assertSuccessfulCheck(
    headChecks,
    RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    pullIdentity.headSha,
  );
  const requiredSourceChecks = RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name) =>
    assertSuccessfulCheck(sourceChecks, name, context.sourceSha),
  );
  const terminalMain = await api.get(repositoryPath("/git/ref/heads/main"));
  assertMainRef(terminalMain, context.sourceSha, "terminal release main");

  const provenance = {
    version: 2,
    repository: RELEASE_AUTOMATION_CONTRACT.repository,
    sourceSha: context.sourceSha,
    sourceTreeSha: source.treeSha,
    sourceParents: source.parents,
    pullRequestNumber: pullNumber,
    mergeMethod,
    providerPullCommitCount: pullIdentity.commitCount,
    mergedAt: new Date(pullIdentity.mergedAt).toISOString(),
    reviewedBaseSha: pullIdentity.baseSha,
    reviewedBaseTreeSha: base.treeSha,
    reviewedHeadSha: pullIdentity.headSha,
    reviewedHeadTreeSha: head.treeSha,
    releaseHead: {
      name: releaseHeadTag,
      ref: `refs/tags/${releaseHeadTag}`,
      sha: pullIdentity.headSha,
    },
    releaseHeadRelease,
    review: {
      type: reviewType,
      id: decision.id,
      url: reviewUrl,
      evidenceSha256: reviewEvidenceSha256,
    },
    sourceAdmission,
    requiredSourceChecks,
  };
  logger.log(
    `Verified PR #${pullNumber} ${mergeMethod} provenance and exact checks for ${context.sourceSha}.`,
  );
  return provenance;
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
  if (command === "seal-release-head") {
    const result = await sealReleaseHeadEvidence({ env });
    writeOutputs(
      {
        release_head_pr_number: result.prNumber,
        release_head_sha: result.headSha,
        release_head_ref: result.releaseHead.ref,
      },
      env,
    );
    return;
  }
  if (command === "recover-release-head") {
    const result = await recoverReleaseHeadEvidence({ env });
    writeOutputs(
      {
        release_head_pr_number: result.prNumber,
        release_head_sha: result.headSha,
        release_head_ref: result.releaseHead.ref,
        release_head_merged_source_sha: result.sourceSha,
      },
      env,
    );
    return;
  }
  if (command === "verify-approved-merge") {
    const result = await verifyApprovedMerge({ env });
    writeOutputs(
      {
        approved_pr_number: result.pullRequestNumber,
        approved_pr_head_sha: result.reviewedHeadSha,
        approved_review_id: result.review.id,
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
