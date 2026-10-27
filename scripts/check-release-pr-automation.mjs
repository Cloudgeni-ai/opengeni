import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directTreeManifest,
  verifyHistoricalSourceAdmission,
  verifySourceAdmission,
} from "./check-source-admission.mjs";

const releaseApprovers = Object.freeze([
  Object.freeze({
    login: "jorgensandhaug",
    id: 55702375,
    type: "User",
  }),
  Object.freeze({
    login: "davletd",
    id: 2204825,
    type: "User",
  }),
]);

export const RELEASE_AUTOMATION_CONTRACT = Object.freeze({
  apiUrl: "https://api.github.com",
  serverUrl: "https://github.com",
  repository: "Cloudgeni-ai/opengeni",
  owner: "Cloudgeni-ai",
  defaultBranch: "main",
  versionBranch: "changeset-release/main",
  releaseWorkflowPath: ".github/workflows/release.yml",
  openVersionPrWorkflowPath: ".github/workflows/open-version-pr.yml",
  ciWorkflowPath: ".github/workflows/ci.yml",
  ciWorkflowFile: "ci.yml",
  sealWorkflowPath: ".github/workflows/seal-release-head.yml",
  retainControllerWorkflowPath: ".github/workflows/retain-release-controller.yml",
  sourceAdmissionWorkflowPath: ".github/workflows/source-admission.yml",
  releaseHeadTagPrefix: "opengeni-release-head-",
  releaseHeadReleaseNamePrefix: "Retained OpenGeni release head ",
  versionAuthor: Object.freeze({
    login: "github-actions[bot]",
    id: 41898282,
    type: "Bot",
  }),
  releaseApprovers,
  // Retained for fixture and downstream compatibility; authorization uses
  // releaseApprovers and never assumes this primary entry is the only one.
  releaseApprover: releaseApprovers[0],
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
    // A tested-descendant release additionally binds the push run's landed
    // merge-tree audit and full-green publication jobs to the released tip.
    fullGreenJobs: Object.freeze(["Verify landed merge content", "Publish fully green main SHA"]),
    fullGreenStatus: "Full CI",
    // Exact-head Version PR CI: the ci.yml workflow_dispatch run executes on
    // main at the Version base and checks out the Version head.
    automationCiAdmissionJob: "Admit automation Version PR",
    automationCiReportJob: "Report exact-head automation CI",
    automationCiReportStep: "Complete exact-head automation CI check",
  }),
  // Tested-descendant admission: a Version provenance merge plus a later fully
  // green first-parent main tip that contains it. Bounds fail closed rather than
  // truncating evidence; choose a nearer green tip or cut a new Version instead.
  descendant: Object.freeze({
    maximumInterveningMerges: 100,
    maximumComparedCommits: 2000,
    fullGreenArtifactPrefix: "full-green-main-",
    canaryImageArtifactPrefix: "canary-images-",
    supportedProvenanceMergeMethods: Object.freeze([
      "merge",
      "provider-verified-moving-main-merge",
    ]),
  }),
  // Version-head release: the exact bot Version PR head released from the
  // two-parent merge commit that landed it. Bounds fail closed.
  versionHead: Object.freeze({
    mergeMethod: "merge-version-head",
    maximumAutomationCiRuns: 10,
    maximumReportLogBytes: 1_000_000,
  }),
});

const shaPattern = /^[0-9a-f]{40}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const allowedReleaseTreeBlobModes = new Set(["100644", "100755", "120000"]);
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

// Keep this release-only parser local. The hotfix admission workflow fetches
// check-source-admission.mjs from the immutable production base, so changing
// that helper's bytes on main would disable hotfix admission until production
// caught up with the new digest.
function canonicalReleaseLeafMap(value, expectedSha, label) {
  invariant(value?.sha === expectedSha, `${label} identity changed`);
  invariant(value?.truncated === false, `${label} is truncated`);
  invariant(Array.isArray(value?.tree), `${label} entries are missing`);
  const out = new Map();
  for (const entry of value.tree) {
    invariant(entry !== null && typeof entry === "object", `${label} has an invalid entry`);
    if (entry.type === "tree") continue;
    invariant(
      typeof entry.path === "string" && entry.path.length > 0,
      `${label} has an invalid path`,
    );
    invariant(!out.has(entry.path), `${label} has a duplicate path`);
    const sha = assertSha(entry.sha, `${label} object ${entry.path}`);
    if (entry.type === "blob") {
      invariant(
        allowedReleaseTreeBlobModes.has(entry.mode),
        `${label} has an invalid blob mode: ${entry.path}`,
      );
    } else {
      invariant(
        entry.type === "commit" && entry.mode === "160000",
        `${label} has an invalid leaf: ${entry.path}`,
      );
    }
    out.set(entry.path, { mode: entry.mode, type: entry.type, sha });
  }
  return out;
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
    artifactBytes: async (id) => {
      const path = repositoryPath(
        `/actions/artifacts/${assertPositiveInteger(id, "artifact ID")}/zip`,
      );
      let response = await fetchImpl(`${RELEASE_AUTOMATION_CONTRACT.apiUrl}${path}`, {
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opengeni-release-pr-automation",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.status === 302) {
        const location = new URL(
          assertString(response.headers.get("location"), "artifact download location"),
        );
        invariant(location.protocol === "https:", "artifact download must use HTTPS");
        // The signed storage URL must never receive the GitHub credential.
        response = await fetchImpl(location.href, { redirect: "error" });
      }
      invariant(response.ok === true && response.body, "artifact download failed");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        invariant(size <= 2 * 1024 * 1024, "release receipt archive exceeds 2 MiB");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    jobLogBytes: async (id, maximumBytes) => {
      const path = repositoryPath(`/actions/jobs/${assertPositiveInteger(id, "job ID")}/logs`);
      let response = await fetchImpl(`${RELEASE_AUTOMATION_CONTRACT.apiUrl}${path}`, {
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opengeni-release-pr-automation",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.status === 302) {
        const location = new URL(
          assertString(response.headers.get("location"), "job log download location"),
        );
        invariant(location.protocol === "https:", "job log download must use HTTPS");
        // The signed storage URL must never receive the GitHub credential.
        response = await fetchImpl(location.href, { redirect: "error" });
      }
      invariant(response.ok === true && response.body, "job log download failed");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        invariant(size <= maximumBytes, "job log exceeds its size bound");
        chunks.push(Buffer.from(chunk));
      }
      invariant(size > 0, "job log is empty");
      return Buffer.concat(chunks);
    },
    get: async (path) => (await request("GET", path)).value,
    getOptional: async (path) => {
      const result = await request("GET", path, undefined, [404]);
      return result.status === 404 ? null : result.value;
    },
    patch: async (path, body) => (await request("PATCH", path, body)).value,
    post: async (path, body) => (await request("POST", path, body)).value,
    postAllowing: async (path, body, allowedStatuses) =>
      request("POST", path, body, allowedStatuses),
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
  const actualSha = directMainRefSha(value, label);
  invariant(actualSha === expectedSha, `${label} differs from the admitted base SHA`);
}

function directMainRefSha(value, label = "default branch") {
  invariant(
    value?.ref === `refs/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`,
    `${label} ref changed`,
  );
  invariant(value?.object?.type === "commit", `${label} is not a direct commit ref`);
  return assertSha(value.object.sha, `${label} SHA`);
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
    return createReleaseHeadRef(api, headSha);
  } else {
    assertReleaseHeadRef(existing, headSha);
  }
  const terminal = await api.get(path);
  assertReleaseHeadRef(terminal, headSha);
  return { name: tag, ref: `refs/tags/${tag}`, sha: headSha };
}

async function createReleaseHeadRef(api, headSha) {
  const tag = releaseHeadTagName(headSha);
  const path = repositoryPath(`/git/ref/tags/${tag}`);
  await api.postAllowing(
    repositoryPath("/git/refs"),
    {
      ref: `refs/tags/${tag}`,
      sha: headSha,
    },
    [409, 422],
  );
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
    return createReleaseHeadRelease(api, headSha);
  } else {
    assertReleaseHeadRelease(existing, headSha);
  }
  return assertReleaseHeadRelease(await api.get(path), headSha);
}

async function createReleaseHeadRelease(api, headSha) {
  const tagName = releaseHeadTagName(headSha);
  const path = repositoryPath(`/releases/tags/${tagName}`);
  await api.postAllowing(
    repositoryPath("/releases"),
    {
      tag_name: tagName,
      name: releaseHeadReleaseName(headSha),
      body:
        `Provider-retained exact release-source head ${headSha}. ` +
        "This prerelease exists only as immutable source-retention evidence.",
      draft: false,
      prerelease: true,
      make_latest: "false",
    },
    [409, 422],
  );
  return assertReleaseHeadRelease(await api.get(path), headSha);
}

function assertIdentity(actual, expected, label) {
  const identity = record(actual, label);
  assertString(identity.login, `${label} login`);
  const id = assertPositiveInteger(identity.id, `${label} numeric identity`);
  invariant(id === expected.id, `${label} numeric identity changed`);
  invariant(
    identity.type === "User" || identity.type === "Bot",
    `${label} account type is invalid`,
  );
  invariant(identity.type === expected.type, `${label} account type changed`);
  return identity;
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

function assertMergedVersionPull(pull, expected) {
  const expectedNumber = expected.prNumber ?? expected.number;
  invariant(pull?.number === expectedNumber, "merged Version PR number changed");
  invariant(pull?.state === "closed" && pull?.merged === true, "Version PR is not merged");
  invariant(pull?.draft === false, "merged Version PR is a draft");
  assertIdentity(pull?.user, RELEASE_AUTOMATION_CONTRACT.versionAuthor, "merged Version PR author");
  invariant(
    pull?.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "merged Version PR base branch changed",
  );
  invariant(
    pull?.base?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "merged Version PR base repository changed",
  );
  invariant(pull?.base?.sha === expected.baseSha, "merged Version PR base SHA changed");
  invariant(
    pull?.head?.ref === RELEASE_AUTOMATION_CONTRACT.versionBranch,
    "merged Version PR head branch changed",
  );
  invariant(
    pull?.head?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "merged Version PR is not from the base repository",
  );
  invariant(pull?.head?.sha === expected.headSha, "merged Version PR head SHA changed");
  invariant(pull?.commits === 1, "merged Version PR is not one commit");
  invariant(
    Number.isSafeInteger(pull?.changed_files) && pull.changed_files > 0,
    "merged Version PR changed-file count is invalid",
  );
  return assertSha(pull?.merge_commit_sha, "merged Version PR commit SHA");
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

function versionPrDispatchContext(env) {
  if (env.GITHUB_EVENT_NAME === "push") return releasePushContext(env);
  const context = baseGithubContext(
    env,
    RELEASE_AUTOMATION_CONTRACT.openVersionPrWorkflowPath,
    "workflow_dispatch",
  );
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
  const [pull, versionBranch, headCommit] = await Promise.all([
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.versionBranch}`)),
    api.get(repositoryPath(`/git/commits/${context.headSha}`)),
  ]);
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

async function terminalMergedVersionIdentity(api, context, pull) {
  const mergeSha = assertMergedVersionPull(pull, context);
  const [headCommit, mergeCommit] = await Promise.all([
    api.get(repositoryPath(`/git/commits/${context.headSha}`)),
    api.get(repositoryPath(`/git/commits/${mergeSha}`)),
  ]);
  invariant(
    versionHeadParent(headCommit, context.headSha) === context.baseSha,
    "merged Version head parent changed",
  );
  invariant(
    assertSha(headCommit?.tree?.sha, "merged Version head tree SHA") ===
      assertSha(mergeCommit?.tree?.sha, "merged Version commit tree SHA"),
    "merged Version commit tree differs from its exact head",
  );
  invariant(
    assertSha(mergeCommit?.sha, "merged Version commit SHA") === mergeSha,
    "merged Version commit changed",
  );
  invariant(
    Array.isArray(mergeCommit?.parents) &&
      ((mergeCommit.parents.length === 1 && mergeCommit.parents[0]?.sha === context.baseSha) ||
        (mergeCommit.parents.length === 2 &&
          mergeCommit.parents[0]?.sha === context.baseSha &&
          mergeCommit.parents[1]?.sha === context.headSha)),
    "merged Version commit topology changed",
  );
  return pull;
}

async function terminalCompletableVersionIdentity(api, context) {
  try {
    return await terminalVersionIdentity(api, context);
  } catch (openError) {
    // Completion can race the approved merge and automatic deletion/reuse of
    // changeset-release/main. Accept only provider-proved exact-tree landing.
    const pull = await api.get(repositoryPath(`/pulls/${context.prNumber}`));
    if (pull?.state !== "closed" || pull?.merged !== true) throw openError;
    return terminalMergedVersionIdentity(api, context, pull);
  }
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
  const context = versionPrDispatchContext(env);
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
  const pushRelease =
    run?.event === "push" && run?.path === RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath;
  const dispatchedVersion =
    run?.event === "workflow_dispatch" &&
    run?.path === RELEASE_AUTOMATION_CONTRACT.openVersionPrWorkflowPath;
  invariant(pushRelease || dispatchedVersion, "source run is not a trusted Version PR producer");
  invariant(
    (run?.status === "in_progress" && run.conclusion === null) ||
      (run?.status === "completed" && run.conclusion === "success"),
    "source Release run is neither in progress nor successfully completed",
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
      OPENGENI_SOURCE_ADMISSION_ACTION: "verify_immutable_pr_head",
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
  const [repository, pull, sourceRun] = await Promise.all([
    api.get(repositoryPath("")),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    api.get(repositoryPath(`/actions/runs/${context.sourceRunId}`)),
  ]);
  assertRepository(repository);
  assertVersionPull(pull, context);
  assertSourceRun(sourceRun, context);

  const sourceContext = syntheticSourceAdmissionContext(context, pull);
  const admission = await verifySourceAdmission({
    ...sourceContext,
    fetchImpl,
    logger,
  });
  invariant(
    admission.workflowSha === context.baseSha,
    "source admission returned another workflow SHA",
  );
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

function assertOpenReleasePull(pull, context, expectedBaseSha) {
  invariant(pull?.number === context.prNumber, "release-head pull-request number changed");
  invariant(
    pull?.state === "open" && pull?.merged === false,
    "release-head pull request is not open",
  );
  invariant(pull?.draft === false, "release-head pull request is a draft");
  invariant(
    pull?.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch &&
      pull.base.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "release-head pull-request base changed",
  );
  const baseSha = assertSha(pull.base.sha, "release-head pull-request base SHA");
  if (expectedBaseSha !== undefined) {
    invariant(baseSha === expectedBaseSha, "release-head pull-request base changed");
  }
  invariant(pull?.head?.sha === context.headSha, "release-head pull-request head changed");
  assertString(pull?.head?.ref, "release-head pull-request head branch");
  assertString(pull?.head?.repo?.full_name, "release-head pull-request head repository");
  return baseSha;
}

function releaseHeadRecoveryContext(env, suppliedInputs) {
  const github = baseGithubContext(
    env,
    RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath,
    "workflow_dispatch",
  );
  requiredEnvironment(env, ["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID"]);
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
    workflowRunAttempt: assertPositiveInteger(env.GITHUB_RUN_ATTEMPT, "seal workflow run attempt"),
  };
  invariant(context.headSha !== context.baseSha, "release head SHA equals its base SHA");
  invariant(
    context.sourceSha !== context.baseSha && context.sourceSha !== context.headSha,
    "merged source SHA is not distinct from the reviewed base and head",
  );
  return context;
}

function assertRecoveryReleasePull(pull, context, expected) {
  const identity = assertMergedPull(pull, {
    pullNumber: context.prNumber,
    sourceSha: context.sourceSha,
  });
  invariant(identity.baseSha === context.baseSha, "release-head recovery base SHA changed");
  invariant(identity.headSha === context.headSha, "release-head recovery head SHA changed");
  const headRef = assertString(pull?.head?.ref, "release-head recovery pull-request head branch");
  const headRepository = assertString(
    pull?.head?.repo?.full_name,
    "release-head recovery pull-request head repository",
  );
  if (expected !== undefined) {
    assertIdentity(pull?.user, expected.author, "release-head recovery pull-request author");
    invariant(
      headRef === expected.headRef,
      "release-head recovery pull-request head branch changed",
    );
    invariant(
      headRepository === expected.headRepository,
      "release-head recovery pull-request head repository changed",
    );
  }
  return { ...identity, headRef, headRepository };
}

async function assertSourceAncestorOfCurrentMain(
  api,
  sourceSha,
  currentMainSha,
  label = "current main",
  sourceLabel = "merged source",
) {
  if (sourceSha === currentMainSha) return;
  const comparison = await api.get(repositoryPath(`/compare/${sourceSha}...${currentMainSha}`));
  invariant(comparison?.status === "ahead", `${label} is not ahead of the ${sourceLabel}`);
  invariant(
    comparison?.base_commit?.sha === sourceSha && comparison?.merge_base_commit?.sha === sourceSha,
    `${label} does not retain the ${sourceLabel} as its exact ancestor`,
  );
  invariant(comparison?.behind_by === 0, `${label} is behind the ${sourceLabel}`);
  invariant(
    Number.isSafeInteger(comparison?.ahead_by) && comparison.ahead_by > 0,
    `${label} ancestry distance is invalid`,
  );
  invariant(
    comparison?.total_commits === comparison.ahead_by,
    `${label} ancestry comparison is incomplete`,
  );
}

async function assertReleaseMainRef(api, value, sourceSha, label) {
  const currentMainSha = directMainRefSha(value, label);
  await assertSourceAncestorOfCurrentMain(api, sourceSha, currentMainSha, label, "admitted source");
  return currentMainSha;
}

async function readOptionalReleaseHeadEvidence(api, headSha) {
  const name = releaseHeadTagName(headSha);
  const ref = `refs/tags/${name}`;
  const [retainedRef, retainedRelease] = await Promise.all([
    api.getOptional(repositoryPath(`/git/ref/tags/${name}`)),
    api.getOptional(repositoryPath(`/releases/tags/${name}`)),
  ]);
  invariant(
    (retainedRef === null) === (retainedRelease === null),
    "release head recovery evidence is only partially present",
  );
  if (retainedRef === null) return null;
  const retainedName = assertReleaseHeadRef(retainedRef, headSha);
  const release = assertReleaseHeadRelease(retainedRelease, headSha);
  return {
    releaseHead: { name: retainedName, ref, sha: headSha },
    releaseHeadRelease: release,
  };
}

async function readExistingReleaseHeadEvidence(api, headSha) {
  const evidence = await readOptionalReleaseHeadEvidence(api, headSha);
  invariant(evidence !== null, "release head recovery evidence is absent");
  return evidence;
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
  assertProviderMergeEvent(timeline, context.sourceSha, pullIdentity);
  // A provider squash can be based on a newer, disjoint main commit than the
  // PR's event base. In that case the merged source tree correctly contains
  // both the reviewed head delta and the intervening main delta, so whole-tree
  // equality is not a valid retention precondition. The provider-owned merged
  // PR identity and timeline event above bind the exact base, head, merge SHA,
  // actor, and timestamp; historical source admission below independently
  // proves the reviewed base→head file manifest. The ordinary release verifier
  // remains responsible for proving the final source composition.
  const mergeMethod =
    source.treeSha === head.treeSha
      ? await classifyMergeOutcome(api, source, pullIdentity)
      : "provider-verified-moving-main";
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
  const initialEvidence = await readOptionalReleaseHeadEvidence(api, context.headSha);
  const [preMutationMain, preMutationPull, preMutationEvidence, preMutationChecks] =
    await Promise.all([
      api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
      api.get(repositoryPath(`/pulls/${context.prNumber}`)),
      readOptionalReleaseHeadEvidence(api, context.headSha),
      paginatedCheckRuns(api, context.headSha),
    ]);
  assertMainRef(preMutationMain, context.sha, "pre-mutation release-head recovery default branch");
  assertRecoveryReleasePull(preMutationPull, context, pullIdentity);
  invariant(
    JSON.stringify(preMutationEvidence) === JSON.stringify(initialEvidence),
    "release head evidence moved before recovery mutation",
  );
  let existingRetention;
  if (initialEvidence === null) {
    invariant(
      preMutationChecks.every(
        (check) => check?.name !== RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
      ),
      "release head retention check exists without retained evidence",
    );
  } else {
    const retentionContext = {
      ...context,
      releaseHeadRelease: initialEvidence.releaseHeadRelease,
    };
    existingRetention = await findCheckRun(
      api,
      retentionContext,
      checkIdentity("release-head-retention", retentionContext),
    );
  }

  const { releaseHead, releaseHeadRelease } = initialEvidence ?? {
    releaseHead: await createReleaseHeadRef(api, context.headSha),
    releaseHeadRelease: await createReleaseHeadRelease(api, context.headSha),
  };

  const now = options.now ?? (() => new Date());
  const checkContext = { ...context, releaseHeadRelease };
  await upsertCheckRun(
    api,
    checkContext,
    "source-admission-recovery",
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
    "source-admission-recovery",
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
  const sourceAdmissionIdentity = checkIdentity("source-admission-recovery", checkContext);
  const sourceAdmission = assertSuccessfulCheckRun(
    await findCheckRun(api, checkContext, sourceAdmissionIdentity),
    RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    context.headSha,
    sourceAdmissionIdentity.externalId,
  );
  if (!existingRetention) {
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
  }

  const [terminalMain, terminalPull, terminalEvidence] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/pulls/${context.prNumber}`)),
    readExistingReleaseHeadEvidence(api, context.headSha),
  ]);
  assertMainRef(terminalMain, context.sha, "terminal release-head recovery default branch");
  assertRecoveryReleasePull(terminalPull, context, pullIdentity);
  invariant(
    JSON.stringify(terminalEvidence.releaseHead) === JSON.stringify(releaseHead),
    "release head ref moved during recovery",
  );
  invariant(
    JSON.stringify(terminalEvidence.releaseHeadRelease) === JSON.stringify(releaseHeadRelease),
    "release head immutable release moved during recovery",
  );
  if (!existingRetention) {
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
  }
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
  const pullBaseSha = assertOpenReleasePull(pull, context);

  const admission = await verifySourceAdmission({
    ...syntheticSourceAdmissionContext(context, pull),
    fetchImpl,
    logger,
  });
  invariant(
    admission.workflowSha === context.baseSha,
    "source admission returned another workflow SHA",
  );
  invariant(admission.baseSha === pullBaseSha, "source admission returned another PR base SHA");
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
  assertOpenReleasePull(terminalPull, context, pullBaseSha);
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

function retainedControllerContext(env, suppliedControllerSha) {
  const github = baseGithubContext(
    env,
    RELEASE_AUTOMATION_CONTRACT.retainControllerWorkflowPath,
    "workflow_dispatch",
  );
  requiredEnvironment(env, ["GITHUB_REF"]);
  const controllerSha = assertSha(
    suppliedControllerSha ?? env.RELEASE_CONTROLLER_SHA,
    "retained controller SHA",
  );
  invariant(
    env.GITHUB_REF === `refs/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`,
    "retained controller workflow is not running from the default branch",
  );
  invariant(github.sha === controllerSha, "retained controller differs from workflow SHA");
  return { ...github, controllerSha };
}

export async function retainCurrentMainControllerEvidence(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const context = retainedControllerContext(env, options.controllerSha);
  const api = githubClient(options.fetchImpl ?? globalThis.fetch, context.token);
  const [repository, main, controller] = await Promise.all([
    api.get(repositoryPath("")),
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/git/commits/${context.controllerSha}`)),
  ]);
  assertRepository(repository);
  assertMainRef(main, context.controllerSha, "retained controller default branch");
  assertCommit(controller, context.controllerSha, "retained controller commit");

  const releaseHead = await ensureReleaseHeadRef(api, context.controllerSha);
  const releaseHeadRelease = await ensureReleaseHeadRelease(api, context.controllerSha);
  const [terminalMain, terminalRef, terminalRelease] = await Promise.all([
    api.get(repositoryPath(`/git/ref/heads/${RELEASE_AUTOMATION_CONTRACT.defaultBranch}`)),
    api.get(repositoryPath(`/git/ref/tags/${releaseHead.name}`)),
    api.get(repositoryPath(`/releases/tags/${releaseHead.name}`)),
  ]);
  assertMainRef(terminalMain, context.controllerSha, "terminal retained controller default branch");
  assertReleaseHeadRef(terminalRef, context.controllerSha);
  const verifiedRelease = assertReleaseHeadRelease(terminalRelease, context.controllerSha);
  invariant(
    JSON.stringify(verifiedRelease) === JSON.stringify(releaseHeadRelease),
    "retained controller immutable release moved during retention",
  );
  logger.log(`Retained current main ${context.controllerSha} as an immutable release controller.`);
  return { ...context, releaseHead, releaseHeadRelease };
}

function checkIdentity(kind, context) {
  invariant(
    kind === "source-admission" ||
      kind === "source-admission-recovery" ||
      kind === "automation-ci" ||
      kind === "release-head-retention",
    "check kind is invalid",
  );
  const name =
    kind === "source-admission" || kind === "source-admission-recovery"
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
  if (kind === "source-admission-recovery") {
    const workflowRunId = assertPositiveInteger(
      context.workflowRunId,
      "source-admission recovery workflow run ID",
    );
    const workflowRunAttempt = assertPositiveInteger(
      context.workflowRunAttempt,
      "source-admission recovery workflow run attempt",
    );
    return {
      name,
      exclusive: false,
      externalId:
        `opengeni:release-automation:source-admission-recovery:v2:` +
        `pr:${context.prNumber}:head:${context.headSha}:` +
        `run:${workflowRunId}:attempt:${workflowRunAttempt}`,
      migrationExternalIds: [
        `opengeni:release-automation:source-admission:v1:` +
          `pr:${context.prNumber}:head:${context.headSha}`,
      ],
      migrationExternalIdPatterns: [
        new RegExp(
          `^opengeni:release-automation:source-admission-recovery:v2:` +
            `pr:${context.prNumber}:head:${context.headSha}:` +
            `run:[1-9][0-9]*:attempt:[1-9][0-9]*$`,
        ),
      ],
    };
  }
  return {
    name,
    exclusive: kind === "release-head-retention",
    externalId:
      `opengeni:release-automation:${kind}:${kind === "release-head-retention" ? "v2" : "v1"}:` +
      `pr:${context.prNumber}:head:${context.headSha}${retentionIdentity}`,
  };
}

async function findCheckRun(api, context, identity) {
  const canonicalMatches = [];
  const migrationMatches = [];
  const migrationExternalIds = new Set(identity.migrationExternalIds ?? []);
  const acceptedExternalIdPatterns = identity.migrationExternalIdPatterns ?? [];
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
      const externalId = check?.external_id;
      const canonical =
        externalId === identity.externalId ||
        acceptedExternalIdPatterns.some((pattern) => pattern.test(externalId ?? ""));
      const migration = migrationExternalIds.has(externalId);
      if (!canonical && !migration) {
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
      (canonical ? canonicalMatches : migrationMatches).push(check);
    }
    if (response.check_runs.length < recordsPerPage) break;
    invariant(page < maximumPages, "check-run listing exceeded its page limit");
  }
  if (canonicalMatches.length > 1) {
    const suiteIds = new Set(canonicalMatches.map((check) => check?.check_suite?.id));
    invariant(
      identity.exclusive &&
        suiteIds.size === 1 &&
        Number.isSafeInteger(canonicalMatches[0]?.check_suite?.id) &&
        canonicalMatches.every(
          (check) => check?.status === "completed" && check?.conclusion === "success",
        ),
      "multiple check runs share the idempotency marker",
    );
  }
  if (canonicalMatches.length >= 1) return canonicalMatches[0];
  return migrationMatches.length === 1 ? migrationMatches[0] : undefined;
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
  const retain = async (sha) => {
    const ref = await ensureReleaseHeadRef(api, sha);
    const release = await ensureReleaseHeadRelease(api, sha);
    return { ref, release };
  };
  const retainedHead = await retain(context.headSha);
  const retainedController = await retain(context.baseSha);
  const releaseHead = retainedHead.ref;
  const releaseHeadRelease = retainedHead.release;
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
  return {
    ...context,
    releaseHead,
    releaseHeadRelease,
    releaseController: retainedController.ref,
    releaseControllerRelease: retainedController.release,
  };
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
      await terminalCompletableVersionIdentity(api, context);
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

function actionsJobIdentity(check, name, sha) {
  invariant(check?.head_sha === sha, `${name} is bound to another commit`);
  assertGitHubActionsApp(check?.app, name);
  const checkId = assertPositiveInteger(check?.id, `${name} check-run ID`);
  const checkSuiteId = assertPositiveInteger(check?.check_suite?.id, `${name} check-suite ID`);
  const detailsUrl = assertString(check?.details_url, `${name} details URL`);
  const parsedDetailsUrl = new URL(detailsUrl);
  invariant(
    parsedDetailsUrl.origin === RELEASE_AUTOMATION_CONTRACT.serverUrl &&
      parsedDetailsUrl.search === "" &&
      parsedDetailsUrl.hash === "",
    `${name} details URL is not an exact GitHub Actions job URL`,
  );
  const match = parsedDetailsUrl.pathname.match(
    new RegExp(
      `^/${RELEASE_AUTOMATION_CONTRACT.repository}/actions/runs/` +
        `([1-9][0-9]*)/job/([1-9][0-9]*)$`,
    ),
  );
  invariant(match !== null, `${name} details URL is not an exact GitHub Actions job URL`);
  const runId = assertPositiveInteger(match[1], `${name} workflow run ID`);
  const jobId = assertPositiveInteger(match[2], `${name} workflow job ID`);
  invariant(checkId === jobId, `${name} check-run ID differs from its workflow job URL`);
  return { check, checkId, checkSuiteId, detailsUrl, jobId, runId };
}

async function paginatedWorkflowAttemptJobs(api, runId, runAttempt) {
  const rows = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const value = await api.get(
      repositoryPath(
        `/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=${recordsPerPage}&page=${page}`,
      ),
    );
    invariant(Array.isArray(value?.jobs), "workflow-attempt job listing is invalid");
    rows.push(...value.jobs);
    if (value.jobs.length < recordsPerPage) return rows;
  }
  throw new Error(`workflow-attempt job listing exceeded ${maximumPages * recordsPerPage} records`);
}

async function verifySuccessfulSourceChecks(api, checks, names, sha) {
  // GitHub failed-job reruns retain historical check runs under one workflow
  // run/check suite. Bind to that provider-owned run, then require its latest
  // attempt and exact aggregate jobs to be successful instead of trusting a
  // timestamp-selected check or rejecting legitimate retry history outright.
  const identitiesByName = new Map();
  const allIdentities = [];
  for (const name of names) {
    const selected = checks.filter((check) => check?.name === name);
    invariant(selected.length > 0, `${name} check run is missing on ${sha}`);
    const identities = selected.map((check) => actionsJobIdentity(check, name, sha));
    identitiesByName.set(name, identities);
    allIdentities.push(...identities);
  }

  // A main -> production PR may legitimately run the same aggregate check
  // names against the exact source SHA. Treat those provider-owned checks as
  // unrelated evidence: release admission is bound only to the unique CI run
  // triggered by the source commit's push to protected main.
  const observedRunIds = [...new Set(allIdentities.map((identity) => identity.runId))];
  const observedRuns = await Promise.all(
    observedRunIds.map(async (runId) => ({
      runId,
      run: record(
        await api.get(repositoryPath(`/actions/runs/${runId}`)),
        "observed source workflow run",
      ),
    })),
  );
  const authoritativeRuns = observedRuns.filter(
    ({ runId, run }) =>
      run.id === runId &&
      run.event === "push" &&
      run.path === RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath &&
      run.head_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch &&
      run.head_sha === sha &&
      run.repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository &&
      run.head_repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
  );
  invariant(
    authoritativeRuns.length === 1,
    "required source checks do not identify exactly one push CI workflow run",
  );
  const { runId, run } = authoritativeRuns[0];
  const authoritativeIdentities = allIdentities.filter((identity) => identity.runId === runId);
  const checkSuiteIds = new Set(authoritativeIdentities.map((identity) => identity.checkSuiteId));
  invariant(checkSuiteIds.size === 1, "required source checks do not share one check suite");
  const checkSuiteId = authoritativeIdentities[0].checkSuiteId;
  invariant(run.id === runId, "required source workflow run ID changed");
  invariant(
    run.check_suite_id === checkSuiteId,
    "required source workflow run check-suite identity changed",
  );
  invariant(run.event === "push", "required source workflow run was not triggered by a push");
  invariant(
    run.path === RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
    "required source checks did not execute the CI workflow",
  );
  invariant(
    run.head_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    "required source workflow branch changed",
  );
  invariant(run.head_sha === sha, "required source workflow run is bound to another commit");
  invariant(
    run.repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository &&
      run.head_repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "required source workflow repository changed",
  );
  invariant(
    run.html_url ===
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
        `/actions/runs/${runId}`,
    "required source workflow URL changed",
  );
  const runAttempt = assertPositiveInteger(run.run_attempt, "required source workflow attempt");
  invariant(
    run.status === "completed" && run.conclusion === "success",
    "required source workflow did not complete successfully",
  );

  const jobs = await paginatedWorkflowAttemptJobs(api, runId, runAttempt);
  return names.map((name) => {
    const selectedJobs = jobs.filter((job) => job?.name === name);
    invariant(
      selectedJobs.length === 1,
      `${name} is not represented by exactly one job in the authoritative workflow attempt`,
    );
    const job = selectedJobs[0];
    const jobId = assertPositiveInteger(job?.id, `${name} authoritative workflow job ID`);
    invariant(
      job.status === "completed" && job.conclusion === "success",
      `${name} did not complete successfully in the authoritative workflow attempt`,
    );
    invariant(
      job.html_url ===
        `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
          `/actions/runs/${runId}/job/${jobId}`,
      `${name} authoritative workflow job URL changed`,
    );
    invariant(
      job.check_run_url ===
        `${RELEASE_AUTOMATION_CONTRACT.apiUrl}/repos/${RELEASE_AUTOMATION_CONTRACT.repository}` +
          `/check-runs/${jobId}`,
      `${name} authoritative workflow job check-run URL changed`,
    );
    const latest = identitiesByName.get(name).filter((identity) => identity.jobId === jobId);
    invariant(
      latest.length === 1,
      `${name} authoritative workflow job is not represented by exactly one check run`,
    );
    invariant(
      latest[0].check.status === "completed" && latest[0].check.conclusion === "success",
      `${name} authoritative check run did not complete successfully`,
    );
    return Object.freeze({
      name,
      appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
      appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
      workflowRunId: runId,
      workflowRunAttempt: runAttempt,
      workflowJobId: jobId,
    });
  });
}

function assertSuccessfulCheckRun(check, name, sha, externalId) {
  invariant(check !== undefined, `${name} canonical check run is missing on ${sha}`);
  invariant(check?.name === name, `${name} canonical check has another name`);
  invariant(check?.head_sha === sha, `${name} canonical check is bound to another commit`);
  invariant(
    check?.external_id === externalId,
    `${name} canonical check has another idempotency identity`,
  );
  assertGitHubActionsApp(check?.app, `${name} canonical check`);
  invariant(
    check.status === "completed" && check.conclusion === "success",
    `${name} canonical check did not complete successfully`,
  );
  return Object.freeze({
    name,
    appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
    appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
  });
}

async function verifyDurableSourceAdmission({
  api,
  checks,
  pull,
  pullNumber,
  baseSha,
  headSha,
  token,
  fetchImpl,
  logger,
}) {
  const matching = checks.filter(
    (check) => check?.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
  );
  const canonicalPrefix =
    `opengeni:release-automation:source-admission-recovery:v2:` +
    `pr:${pullNumber}:head:${headSha}:run:`;
  const canonicalPattern = new RegExp(`^${canonicalPrefix}([1-9][0-9]*):attempt:([1-9][0-9]*)$`);
  const canonical = matching.filter((check) => canonicalPattern.test(check?.external_id ?? ""));
  invariant(canonical.length <= 1, "canonical recovered source-admission check is not unique");
  if (canonical.length === 1) {
    const canonicalExternalId = assertString(
      canonical[0]?.external_id,
      "canonical recovered source-admission external ID",
    );
    return assertSuccessfulCheckRun(
      canonical[0],
      RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      headSha,
      canonicalExternalId,
    );
  }
  if (matching.length > 0) {
    return assertSuccessfulCheck(
      checks,
      RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      headSha,
    );
  }

  // GitHub may discard every check-run projection for a merged head when its
  // source branch is deleted. The retained commit/release and the provider PR
  // objects remain authoritative, so reconstruct the same admission directly
  // instead of making a post-merge release depend on disposable UI state.
  const historical = await verifyHistoricalSourceAdmission({
    number: pullNumber,
    baseSha,
    headSha,
    headRef: assertString(pull?.head?.ref, "historical source-admission head ref"),
    headRepository: assertString(
      pull?.head?.repo?.full_name,
      "historical source-admission head repository",
    ),
    token,
    fetchImpl,
    logger,
  });
  const terminalChecks = await paginatedCheckRuns(api, headSha);
  invariant(
    terminalChecks.every(
      (check) => check?.name !== RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    ),
    "source-admission check projection changed during historical reconstruction",
  );
  return Object.freeze({
    name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
    appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
    reconstructed: true,
    manifestSha256: historical.manifestSha256,
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
  return {
    baseSha,
    headSha,
    mergedAt,
    author,
    merger,
    commitCount: value.commits,
  };
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
  // GitHub can record the timeline event a second after pull.merged_at.
  // Bind identity to the exact commit and actor, not independently recorded clocks.
  assertTimestamp(event.created_at, "provider merge event timestamp");
  assertIdentity(event.actor, pullIdentity.merger, "provider merge actor");
  assertString(event.node_id, "provider merge event node ID");
  const eventId = assertPositiveInteger(event.id, "provider merge event ID");
  invariant(
    event.url === repositoryApiUrl(`/issues/events/${eventId}`),
    "provider merge event URL changed",
  );
}

function canonicalSha256(value) {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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

function treeManifestSha256(manifest) {
  const text = `${manifest.map(({ line }) => line).join("\n")}\n`;
  return createHash("sha256").update(text).digest("hex");
}

function manifestsMatch(left, right) {
  return (
    left.length === right.length && left.every((entry, index) => entry.line === right[index]?.line)
  );
}

async function classifyReleaseSourceComposition(api, source, base, head, pullIdentity) {
  if (source.treeSha === head.treeSha) {
    return {
      mergeMethod: await classifyMergeOutcome(api, source, pullIdentity),
      sourceComposition: {
        type: "exact-reviewed-tree",
        reviewedTreeSha: head.treeSha,
      },
    };
  }

  const queuedMerge = source.parents.length === 2 && source.parents[1] === pullIdentity.headSha;
  invariant(
    source.parents.length === 1 || queuedMerge,
    "release source tree differs from the exact reviewed head and is not a moving-main squash or exact-head merge",
  );
  const integrationBaseSha = source.parents[0];
  // A merged PR's provider base may already be its landing parent. Its patch
  // still starts at the head/base merge base, not at that later target tree.
  const comparison = await api.get(
    repositoryPath(`/compare/${pullIdentity.baseSha}...${pullIdentity.headSha}`),
  );
  invariant(
    comparison?.base_commit?.sha === pullIdentity.baseSha &&
      comparison?.commits?.at(-1)?.sha === pullIdentity.headSha &&
      Number.isSafeInteger(comparison?.ahead_by) &&
      comparison.ahead_by > 0,
    "reviewed release patch comparison identity changed",
  );
  const patchBaseSha = assertSha(comparison?.merge_base_commit?.sha, "reviewed patch-base SHA");
  invariant(
    integrationBaseSha !== patchBaseSha,
    "release source tree differs from the exact reviewed head on its exact PR base",
  );
  await assertSourceAncestorOfCurrentMain(
    api,
    pullIdentity.baseSha,
    integrationBaseSha,
    "moving-main integration base",
    "reviewed base",
  );
  const integrationBase = assertCommit(
    await api.get(repositoryPath(`/git/commits/${integrationBaseSha}`)),
    integrationBaseSha,
    "moving-main integration-base commit",
  );
  const patchBase =
    patchBaseSha === base.sha
      ? base
      : assertCommit(
          await api.get(repositoryPath(`/git/commits/${patchBaseSha}`)),
          patchBaseSha,
          "reviewed patch-base commit",
        );
  const [baseTree, headTree, integrationBaseTree, sourceTree] = await Promise.all([
    api.get(repositoryPath(`/git/trees/${patchBase.treeSha}?recursive=1`)),
    api.get(repositoryPath(`/git/trees/${head.treeSha}?recursive=1`)),
    api.get(repositoryPath(`/git/trees/${integrationBase.treeSha}?recursive=1`)),
    api.get(repositoryPath(`/git/trees/${source.treeSha}?recursive=1`)),
  ]);
  const reviewedManifest = directTreeManifest(
    canonicalReleaseLeafMap(baseTree, patchBase.treeSha, "reviewed patch-base tree"),
    canonicalReleaseLeafMap(headTree, head.treeSha, "reviewed head tree"),
  );
  const landedManifest = directTreeManifest(
    canonicalReleaseLeafMap(
      integrationBaseTree,
      integrationBase.treeSha,
      "moving-main integration-base tree",
    ),
    canonicalReleaseLeafMap(sourceTree, source.treeSha, "moving-main release source tree"),
  );
  invariant(reviewedManifest.length > 0, "reviewed release tree delta is empty");
  invariant(
    manifestsMatch(reviewedManifest, landedManifest),
    "release source tree differs from the exact reviewed moving-main composition",
  );
  return {
    mergeMethod: queuedMerge
      ? "provider-verified-moving-main-merge"
      : "provider-verified-moving-main-squash",
    sourceComposition: {
      type: "exact-reviewed-delta-on-moving-main",
      patchBaseSha,
      integrationBaseSha,
      integrationBaseTreeSha: integrationBase.treeSha,
      manifestSha256: treeManifestSha256(reviewedManifest),
      pathCount: reviewedManifest.length,
    },
  };
}

function releaseApprovalContext(env, suppliedSourceSha, suppliedProvenanceSha) {
  requiredEnvironment(env, [
    "GITHUB_API_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_TOKEN",
    "GITHUB_WORKFLOW_SHA",
    "RELEASE_CONTROLLER_SHA",
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
  const controllerSha = assertSha(env.RELEASE_CONTROLLER_SHA, "release controller SHA");
  invariant(
    assertSha(env.GITHUB_SHA, "GITHUB_SHA") === controllerSha,
    "dispatch ref differs from release controller SHA",
  );
  invariant(
    assertSha(env.GITHUB_WORKFLOW_SHA, "GITHUB_WORKFLOW_SHA") === controllerSha,
    "workflow definition differs from release controller SHA",
  );
  invariant(
    env.GITHUB_REF === `refs/tags/${releaseHeadTagName(controllerSha)}`,
    "release workflow is not running from the retained controller ref",
  );
  invariant(controllerSha !== sourceSha, "release controller must differ from release source");
  // The Version provenance SHA is explicit and separate from the released
  // candidate SHA. Omitted or equal means the established exact-source lane.
  const suppliedProvenance = suppliedProvenanceSha ?? env.RELEASE_PROVENANCE_SHA ?? "";
  invariant(typeof suppliedProvenance === "string", "Version provenance SHA is invalid");
  const provenanceSha =
    suppliedProvenance === "" ? sourceSha : assertSha(suppliedProvenance, "Version provenance SHA");
  invariant(
    controllerSha !== provenanceSha,
    "release controller must differ from the Version provenance",
  );
  return {
    controllerSha,
    sourceSha,
    provenanceSha,
    descendant: provenanceSha !== sourceSha,
    token: env.GITHUB_TOKEN,
  };
}

async function readRetainedReleaseController(api, context) {
  const controllerTag = releaseHeadTagName(context.controllerSha);
  const [initialMain, controllerValue, controllerRef, controllerReleaseValue] = await Promise.all([
    api.get(repositoryPath("/git/ref/heads/main")),
    api.get(repositoryPath(`/git/commits/${context.controllerSha}`)),
    api.get(repositoryPath(`/git/ref/tags/${controllerTag}`)),
    api.get(repositoryPath(`/releases/tags/${controllerTag}`)),
  ]);
  // The released source (the exact source or the tested descendant tip) must be
  // retained on protected main before any provenance is trusted.
  const initialMainSha = await assertReleaseMainRef(
    api,
    initialMain,
    context.sourceSha,
    "initial release main",
  );
  const controller = assertCommit(
    controllerValue,
    context.controllerSha,
    "release controller commit",
  );
  assertReleaseHeadRef(controllerRef, context.controllerSha);
  const controllerRelease = assertReleaseHeadRelease(controllerReleaseValue, context.controllerSha);
  return { initialMainSha, controller, controllerRelease };
}

// Binds one provider merge result to exactly one merged pull request, its
// detail projection and its single provider merge event.
// With allowVersionHead, a source that is the head (not the merge result) of
// its only associated pull request is returned unverified for the separate
// Version-head lane, which proves that shape strictly.
async function readMergedReleasePull(api, mergeSha, label = "release source", options = {}) {
  const source = assertCommit(
    await api.get(repositoryPath(`/git/commits/${mergeSha}`)),
    mergeSha,
    `${label} commit`,
  );

  const pulls = await paginatedArray(
    api,
    repositoryPath(`/commits/${mergeSha}/pulls`),
    "associated pull requests",
  );
  invariant(pulls.length === 1, `${label} is not associated with exactly one pull request`);
  const associatedPull = record(pulls[0], "associated pull request");
  const pullNumber = assertPositiveInteger(associatedPull.number, "associated pull-request number");
  if (
    options.allowVersionHead === true &&
    associatedPull.merge_commit_sha !== mergeSha &&
    associatedPull.head?.sha === mergeSha
  ) {
    return { versionHead: true, source, associatedPull, pullNumber };
  }
  invariant(
    associatedPull.merge_commit_sha === mergeSha,
    "associated pull summary merge SHA changed",
  );
  const pull = record(await api.get(repositoryPath(`/pulls/${pullNumber}`)), "pull-request detail");
  const pullIdentity = assertMergedPull(pull, {
    pullNumber,
    sourceSha: mergeSha,
  });
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
  assertProviderMergeEvent(timeline, mergeSha, pullIdentity);
  return { source, pull, pullNumber, pullIdentity };
}

function mergedSourceReview(pullNumber, sourceSha, pullIdentity) {
  const reviewUrl =
    `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
    `/pull/${pullNumber}`;
  return {
    type: "merged-source",
    id: pullNumber,
    url: reviewUrl,
    evidenceSha256: canonicalSha256({
      version: 1,
      kind: "merged-source",
      repository: RELEASE_AUTOMATION_CONTRACT.repository,
      pullRequestNumber: pullNumber,
      sourceSha,
      reviewedBaseSha: pullIdentity.baseSha,
      reviewedHeadSha: pullIdentity.headSha,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tested-descendant release admission.
//
// The in-house merge batcher lands one true merge commit per PR and fast-forwards
// main to the exact tested candidate tip. A Version PR is its own singleton
// batch, but its own push CI may be coalesced or fail transiently, so a later
// fully green main tip that contains the Version merge must be releasable.
// The Version provenance SHA (the Version PR's own merge commit) keeps every
// exact reviewed-head/base/source-admission/topology proof; the released
// candidate SHA owns all CI, image and artifact evidence. Nothing proven for
// one commit is substituted for the other.
// ---------------------------------------------------------------------------

function assertVersionProvenancePull(pull) {
  assertIdentity(
    pull?.user,
    RELEASE_AUTOMATION_CONTRACT.versionAuthor,
    "Version provenance pull-request author",
  );
  invariant(
    pull?.head?.ref === RELEASE_AUTOMATION_CONTRACT.versionBranch,
    "Version provenance pull request is not from the Version branch",
  );
  invariant(
    pull?.head?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    "Version provenance pull request is not from the base repository",
  );
}

function descendantCommit(value, index) {
  const sha = assertSha(value?.sha, `descendant commit ${index}`);
  invariant(Array.isArray(value?.parents), `descendant commit ${sha} parents are missing`);
  return {
    sha,
    treeSha: assertSha(value?.commit?.tree?.sha, `descendant commit ${sha} tree SHA`),
    parents: value.parents.map((parent, parentIndex) =>
      assertSha(parent?.sha, `descendant commit ${sha} parent ${parentIndex}`),
    ),
  };
}

// Complete provider ancestry for provenance..candidate in bounded pages. The
// first-parent walk from the candidate must reach the provenance commit through
// true two-parent merges only: direct pushes, squashes, octopus merges and a
// provenance reachable only through a side branch all fail closed.
async function readDescendantFirstParentMerges(api, provenanceSha, candidateSha) {
  const limits = RELEASE_AUTOMATION_CONTRACT.descendant;
  const maximumComparePages = Math.ceil(limits.maximumComparedCommits / recordsPerPage);
  const commits = [];
  let totalCommits;
  for (let page = 1; page <= maximumComparePages; page += 1) {
    const value = await api.get(
      repositoryPath(
        `/compare/${provenanceSha}...${candidateSha}?per_page=${recordsPerPage}&page=${page}`,
      ),
    );
    invariant(
      value?.status === "ahead",
      "release candidate is not strictly ahead of the Version provenance",
    );
    invariant(
      value?.base_commit?.sha === provenanceSha && value?.merge_base_commit?.sha === provenanceSha,
      "release candidate does not retain the Version provenance as its exact ancestor",
    );
    invariant(value?.behind_by === 0, "release candidate is behind the Version provenance");
    invariant(
      Number.isSafeInteger(value?.total_commits) &&
        value.total_commits > 0 &&
        value.ahead_by === value.total_commits,
      "descendant ancestry comparison is incomplete",
    );
    invariant(
      value.total_commits <= limits.maximumComparedCommits,
      `release candidate is more than ${limits.maximumComparedCommits} commits beyond the Version provenance; choose a nearer fully green tip`,
    );
    totalCommits ??= value.total_commits;
    invariant(
      value.total_commits === totalCommits,
      "descendant ancestry comparison changed during pagination",
    );
    invariant(Array.isArray(value.commits), "descendant ancestry commits are missing");
    commits.push(...value.commits);
    if (commits.length >= totalCommits) break;
    invariant(
      value.commits.length === recordsPerPage,
      "descendant ancestry comparison is incomplete",
    );
  }
  invariant(
    commits.length === totalCommits,
    "descendant ancestry comparison does not contain the complete commit range",
  );
  const bySha = new Map();
  for (const [index, value] of commits.entries()) {
    const commit = descendantCommit(value, index);
    invariant(!bySha.has(commit.sha), "descendant ancestry comparison has a duplicate commit");
    bySha.set(commit.sha, commit);
  }
  invariant(
    !bySha.has(provenanceSha) && bySha.has(candidateSha),
    "descendant ancestry comparison does not terminate at the release candidate",
  );
  const chain = [];
  for (let current = candidateSha; current !== provenanceSha;) {
    const commit = bySha.get(current);
    invariant(
      commit !== undefined,
      "Version provenance is not on the release candidate's first-parent main history",
    );
    invariant(
      commit.parents.length === 2,
      `intervening first-parent commit ${current} is not a two-parent merge`,
    );
    chain.push(commit);
    invariant(
      chain.length <= limits.maximumInterveningMerges,
      `release candidate is more than ${limits.maximumInterveningMerges} merges beyond the Version provenance; choose a nearer fully green tip`,
    );
    current = commit.parents[0];
  }
  return chain.reverse();
}

// Every intervening merge must be the provider merge result of exactly one PR
// merged into main whose exact head is the merge's second parent. A newer
// Version PR in the range makes the requested provenance stale.
async function verifyInterveningMergePull(api, merge) {
  const pulls = await paginatedArray(
    api,
    repositoryPath(`/commits/${merge.sha}/pulls`),
    "intervening merge associated pull requests",
  );
  invariant(
    pulls.length === 1,
    `intervening merge ${merge.sha} is not associated with exactly one pull request`,
  );
  const pull = record(pulls[0], "intervening merge pull request");
  const number = assertPositiveInteger(pull.number, "intervening pull-request number");
  invariant(
    pull.merge_commit_sha === merge.sha,
    `intervening merge ${merge.sha} is not the provider merge result of PR #${number}`,
  );
  invariant(pull.state === "closed", `intervening PR #${number} is not closed`);
  assertTimestamp(pull.merged_at, `intervening PR #${number} merge timestamp`);
  invariant(
    pull.base?.ref === RELEASE_AUTOMATION_CONTRACT.defaultBranch &&
      pull.base?.repo?.full_name === RELEASE_AUTOMATION_CONTRACT.repository,
    `intervening PR #${number} did not merge into protected main`,
  );
  invariant(
    pull.head?.sha === merge.parents[1],
    `intervening merge ${merge.sha} does not retain PR #${number}'s exact head`,
  );
  invariant(
    pull.head?.ref !== RELEASE_AUTOMATION_CONTRACT.versionBranch,
    `intervening merge ${merge.sha} lands competing Version PR #${number}; release that newer Version provenance instead`,
  );
  return Object.freeze({
    sha: merge.sha,
    treeSha: merge.treeSha,
    parents: Object.freeze([...merge.parents]),
    pullRequestNumber: number,
    headSha: merge.parents[1],
  });
}

const pendingChangesetPattern = /^\.changeset\/[^/]+\.md$/;

// Released bytes must still carry the exact reviewed Version content: every
// path the Version PR changed keeps its reviewed leaf, and no later changeset
// makes the Version stale.
async function verifyVersionContentRetained(api, base, head, candidate) {
  const [baseTree, headTree, candidateTree] = await Promise.all([
    api.get(repositoryPath(`/git/trees/${base.treeSha}?recursive=1`)),
    api.get(repositoryPath(`/git/trees/${head.treeSha}?recursive=1`)),
    api.get(repositoryPath(`/git/trees/${candidate.treeSha}?recursive=1`)),
  ]);
  const reviewed = directTreeManifest(
    canonicalReleaseLeafMap(baseTree, base.treeSha, "reviewed Version base tree"),
    canonicalReleaseLeafMap(headTree, head.treeSha, "reviewed Version head tree"),
  );
  invariant(reviewed.length > 0, "reviewed Version tree delta is empty");
  const released = canonicalReleaseLeafMap(
    candidateTree,
    candidate.treeSha,
    "release candidate tree",
  );
  for (const entry of reviewed) {
    invariant(
      JSON.stringify(released.get(entry.path) ?? null) === JSON.stringify(entry.after),
      `release candidate changes reviewed Version content at ${entry.path}`,
    );
  }
  for (const path of released.keys()) {
    invariant(
      !pendingChangesetPattern.test(path) || path === ".changeset/README.md",
      `release candidate has a pending changeset after the Version provenance: ${path}`,
    );
  }
  return Object.freeze({
    reviewedPathCount: reviewed.length,
    reviewedManifestSha256: treeManifestSha256(reviewed),
  });
}

function gitAuditCommand(gitDir, args) {
  const result = spawnSync("git", args, {
    cwd: gitDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  invariant(result.error === undefined, `git ${args[0]} could not run`);
  return { status: result.status, stdout: result.stdout.trim() };
}

function gitAuditOutput(gitDir, args, message) {
  const result = gitAuditCommand(gitDir, args);
  invariant(result.status === 0, message);
  return result.stdout;
}

/**
 * Independently recompute every first-parent merge from the Version provenance
 * through the released candidate with `git merge-tree`, using local Git objects
 * fetched as data. Hand-resolved, conflicting, single-parent or octopus commits
 * and a provenance off the candidate's first-parent chain fail closed.
 */
export function auditDescendantMergeContent({
  gitDir,
  provenanceSha,
  candidateSha,
  maximumMerges = RELEASE_AUTOMATION_CONTRACT.descendant.maximumInterveningMerges,
}) {
  assertString(gitDir, "descendant Git directory");
  assertSha(provenanceSha, "Version provenance SHA");
  assertSha(candidateSha, "release candidate SHA");
  invariant(provenanceSha !== candidateSha, "release candidate equals the Version provenance");
  invariant(
    gitAuditOutput(
      gitDir,
      ["rev-parse", "--is-shallow-repository"],
      "descendant Git history is unavailable",
    ) === "false",
    "descendant Git history is shallow",
  );
  for (const sha of [provenanceSha, candidateSha]) {
    invariant(
      gitAuditOutput(gitDir, ["cat-file", "-t", sha], `descendant Git object ${sha} is missing`) ===
        "commit",
      `descendant Git object ${sha} is not a commit`,
    );
  }
  invariant(
    gitAuditCommand(gitDir, ["merge-base", "--is-ancestor", provenanceSha, candidateSha]).status ===
      0,
    "release candidate does not contain the Version provenance commit",
  );
  const descendants = gitAuditOutput(
    gitDir,
    ["rev-list", "--first-parent", "--reverse", `${provenanceSha}..${candidateSha}`],
    "descendant first-parent history is unavailable",
  )
    .split("\n")
    .filter(Boolean);
  invariant(
    descendants.length > 0 && descendants.length <= maximumMerges,
    "descendant first-parent history length is outside the admitted bound",
  );
  invariant(
    descendants.at(-1) === candidateSha,
    "descendant history does not end at the candidate",
  );
  const merges = [];
  let expectedFirstParent = null;
  for (const sha of [provenanceSha, ...descendants]) {
    assertSha(sha, "descendant first-parent commit");
    const parents = gitAuditOutput(
      gitDir,
      ["rev-list", "--parents", "-n", "1", sha],
      `descendant commit ${sha} parents are unavailable`,
    )
      .split(" ")
      .slice(1);
    invariant(
      parents.length === 2,
      `descendant first-parent commit ${sha} is not a two-parent merge`,
    );
    if (expectedFirstParent !== null) {
      invariant(
        parents[0] === expectedFirstParent,
        "Version provenance is not on the release candidate's first-parent main history",
      );
    }
    const recomputed = gitAuditCommand(gitDir, [
      "merge-tree",
      "--write-tree",
      "--no-messages",
      parents[0],
      parents[1],
    ]);
    invariant(
      recomputed.status === 0,
      `landed merge ${sha} cannot be recomputed without conflict resolution`,
    );
    const expectedTree = recomputed.stdout.split("\n")[0];
    const treeSha = gitAuditOutput(
      gitDir,
      ["rev-parse", `${sha}^{tree}`],
      `descendant commit ${sha} tree is unavailable`,
    );
    invariant(
      expectedTree === treeSha,
      `landed merge content mismatch at ${sha}: expected ${expectedTree}, got ${treeSha}`,
    );
    merges.push({ sha, parents, treeSha });
    expectedFirstParent = sha;
  }
  return { schemaVersion: 1, provenanceSha, candidateSha, merges };
}

function mergeListSha256(merges) {
  const text = merges
    .map(({ sha, parents, treeSha }) => `${sha}\t${parents.join(",")}\t${treeSha}`)
    .join("\n");
  return createHash("sha256").update(`${text}\n`).digest("hex");
}

// The local merge-tree audit must describe exactly the provider-proven chain.
function verifyMergeContentAudit(value, provenance, interveningMerges, candidateSha) {
  const audit = record(value, "descendant merge-content audit");
  invariant(audit.schemaVersion === 1, "descendant merge-content audit schema changed");
  invariant(
    audit.provenanceSha === provenance.sha && audit.candidateSha === candidateSha,
    "descendant merge-content audit covers another range",
  );
  invariant(Array.isArray(audit.merges), "descendant merge-content audit merges are missing");
  const expected = [provenance, ...interveningMerges];
  invariant(
    audit.merges.length === expected.length,
    "descendant merge-content audit differs from provider first-parent history",
  );
  for (const [index, merge] of expected.entries()) {
    const audited = record(audit.merges[index], "descendant merge-content audit entry");
    invariant(
      audited.sha === merge.sha &&
        audited.treeSha === merge.treeSha &&
        Array.isArray(audited.parents) &&
        audited.parents.length === merge.parents.length &&
        audited.parents.every((parent, parentIndex) => parent === merge.parents[parentIndex]),
      `descendant merge-content audit differs from provider evidence at ${merge.sha}`,
    );
  }
  return Object.freeze({
    method: "git-merge-tree-write-tree",
    auditedMergeCount: expected.length,
    mergesSha256: mergeListSha256(expected),
  });
}

function fullGreenAttemptUrl(runId, runAttempt) {
  return (
    `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
    `/actions/runs/${runId}/attempts/${runAttempt}`
  );
}

// The fully green receipt is the GitHub Actions bot's `Full CI` commit status
// linking the exact authoritative push-run attempt. Queue/batch readiness never
// substitutes, and a foreign or conflicting `Full CI` status fails closed.
async function verifyFullGreenStatus(api, sha, runId, runAttempt) {
  const context = RELEASE_AUTOMATION_CONTRACT.checks.fullGreenStatus;
  const statuses = await paginatedArray(
    api,
    repositoryPath(`/commits/${sha}/statuses`),
    "commit statuses",
  );
  const selected = statuses.filter((status) => status?.context === context);
  invariant(selected.length > 0, `${context} status is missing on ${sha}`);
  const runPrefix = `${fullGreenAttemptUrl(runId, "")}`;
  const parsed = selected.map((status) => {
    const creator = assertIdentity(
      status?.creator,
      RELEASE_AUTOMATION_CONTRACT.versionAuthor,
      `${context} status creator`,
    );
    invariant(
      creator.login === RELEASE_AUTOMATION_CONTRACT.versionAuthor.login,
      `${context} status was not created by the GitHub Actions bot`,
    );
    const targetUrl = assertString(status?.target_url, `${context} status target URL`);
    invariant(
      targetUrl.startsWith(runPrefix) &&
        positiveIntegerPattern.test(targetUrl.slice(runPrefix.length)),
      `${context} status references another workflow run`,
    );
    return {
      id: assertPositiveInteger(status?.id, `${context} status ID`),
      state: status?.state,
      targetUrl,
      createdAt: assertTimestamp(status?.created_at, `${context} status timestamp`),
    };
  });
  parsed.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
  const latest = parsed[0];
  invariant(
    latest.state === "success" && latest.targetUrl === fullGreenAttemptUrl(runId, runAttempt),
    `latest ${context} status is not a success for the exact authoritative run attempt`,
  );
  return Object.freeze({
    context,
    id: latest.id,
    targetUrl: latest.targetUrl,
    createdAt: new Date(latest.createdAt).toISOString(),
  });
}

function readReceiptArchive(bytes, digest, receiptFile) {
  invariant(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest,
    "downloaded receipt archive digest differs from GitHub metadata",
  );
  const directory = mkdtempSync(join(tmpdir(), "opengeni-release-receipt-"));
  try {
    const archive = join(directory, "receipt.zip");
    writeFileSync(archive, bytes);
    const list = spawnSync("unzip", ["-Z1", archive], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 128 * 1024,
    });
    invariant(list.status === 0, "cannot inspect release receipt ZIP");
    const names = list.stdout.trim().split("\n");
    const allowed =
      receiptFile === "canary-images.json" ? [receiptFile, "canary-images.sha256"] : [receiptFile];
    invariant(
      names.length === allowed.length &&
        new Set(names).size === names.length &&
        names.every((name) => allowed.includes(name)),
      "release receipt ZIP has unexpected or duplicate members",
    );
    const read = (name) => {
      const result = spawnSync("unzip", ["-p", archive, name], {
        timeout: 10000,
        maxBuffer: 128 * 1024,
      });
      invariant(result.status === 0, "cannot read release receipt ZIP member");
      return result.stdout;
    };
    const body = read(receiptFile);
    const receiptSha256 = createHash("sha256").update(body).digest("hex");
    if (receiptFile === "canary-images.json") {
      invariant(
        read("canary-images.sha256").toString("utf8").trim() ===
          `${receiptSha256}  canary-images.json`,
        "canary image receipt checksum differs",
      );
    }
    return { receipt: record(JSON.parse(body.toString("utf8")), receiptFile), receiptSha256 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyReceiptBody(receipt, file, sha, runId, runAttempt) {
  invariant(receipt.schemaVersion === 1, `${file} schema changed`);
  if (file === "full-green-main.json") {
    invariant(
      receipt.sha === sha && receipt.mode === "full",
      "full-green receipt names another source or mode",
    );
    // A Batch-attested main push skipped its test lanes (docs/merge-batcher.md
    // "Main-push Batch CI attestation"). It stays valid green-main evidence for
    // canary and merge-content audits, but a release source needs the full suite.
    invariant(
      receipt.attestation === undefined,
      "full-green receipt reused Batch CI; a release source needs the full main suite",
    );
    invariant(
      assertPositiveInteger(receipt.runId, "full-green receipt run ID") === runId &&
        assertPositiveInteger(receipt.runAttempt, "full-green receipt attempt") === runAttempt &&
        receipt.url === fullGreenAttemptUrl(runId, runAttempt),
      "full-green receipt names another run attempt",
    );
    return;
  }
  invariant(
    receipt.source?.sha === sha &&
      receipt.source?.repository === RELEASE_AUTOMATION_CONTRACT.repository &&
      receipt.source?.ref === "refs/heads/main",
    "canary receipt names another source",
  );
  invariant(
    receipt.producer?.workflow === RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath &&
      assertPositiveInteger(receipt.producer?.runId, "canary receipt run ID") === runId &&
      assertPositiveInteger(receipt.producer?.runAttempt, "canary receipt attempt") === runAttempt,
    "canary receipt names another run attempt",
  );
  invariant(receipt.imageTag === `canary-sha-${sha}`, "canary image tag names another source");
  assertString(receipt.chartVersion, "canary receipt chart version");
  for (const role of [
    "api",
    "worker",
    "web",
    "sandbox",
    "relay",
    "artifact-materializer",
    "artifact-outbox-dispatcher",
    "desktop",
  ]) {
    const image = record(receipt.images?.[role], `canary ${role} image`);
    invariant(
      image.repository === `ghcr.io/cloudgeni-ai/opengeni-${role}` &&
        /^sha256:[0-9a-f]{64}$/.test(image.digest ?? ""),
      `canary ${role} image identity is invalid`,
    );
  }
}

async function verifyFullGreenArtifacts(api, sha, runId, runAttempt) {
  const limits = RELEASE_AUTOMATION_CONTRACT.descendant;
  const attempt = await api.get(repositoryPath(`/actions/runs/${runId}/attempts/${runAttempt}`));
  invariant(
    attempt.id === runId &&
      attempt.run_attempt === runAttempt &&
      attempt.head_sha === sha &&
      attempt.status === "completed" &&
      attempt.conclusion === "success",
    "receipt attempt identity changed",
  );
  const startedAt = assertTimestamp(attempt.run_started_at, "receipt attempt start");
  const artifacts = [];
  let totalCount;
  for (let page = 1; page <= maximumPages; page += 1) {
    const value = await api.get(
      repositoryPath(`/actions/runs/${runId}/artifacts?per_page=${recordsPerPage}&page=${page}`),
    );
    invariant(
      Array.isArray(value?.artifacts) && Number.isSafeInteger(value?.total_count),
      "full-green workflow artifact listing is invalid",
    );
    totalCount ??= value.total_count;
    invariant(value.total_count === totalCount, "full-green artifact listing changed");
    artifacts.push(...value.artifacts);
    if (artifacts.length >= totalCount || value.artifacts.length < recordsPerPage) break;
  }
  invariant(artifacts.length === totalCount, "full-green workflow artifact listing is incomplete");
  return Promise.all(
    [`${limits.fullGreenArtifactPrefix}${sha}`, `${limits.canaryImageArtifactPrefix}${sha}`].map(
      async (name) => {
        const selected = artifacts.filter((artifact) => artifact?.name === name);
        invariant(selected.length === 1, `${name} is not exactly one artifact of run ${runId}`);
        const artifact = selected[0];
        invariant(artifact.expired === false, `${name} has expired`);
        invariant(
          artifact.workflow_run?.id === runId &&
            artifact.workflow_run?.head_sha === sha &&
            artifact.workflow_run?.head_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch,
          `${name} is bound to another workflow run or commit`,
        );
        const digest = assertString(artifact.digest, `${name} digest`);
        invariant(/^sha256:[0-9a-f]{64}$/.test(digest), `${name} digest is invalid`);
        invariant(
          assertTimestamp(artifact.created_at, `${name} creation`) >= startedAt,
          `${name} predates the selected CI attempt`,
        );
        const file = name.startsWith(limits.fullGreenArtifactPrefix)
          ? "full-green-main.json"
          : "canary-images.json";
        const { receipt, receiptSha256 } = readReceiptArchive(
          await api.artifactBytes(artifact.id),
          digest,
          file,
        );
        verifyReceiptBody(receipt, file, sha, runId, runAttempt);
        return Object.freeze({
          name,
          id: assertPositiveInteger(artifact.id, `${name} artifact ID`),
          digest,
          receiptSha256,
        });
      },
    ),
  );
}

async function verifyTestedDescendantRelease({ options, env, logger, context, api }) {
  const limits = RELEASE_AUTOMATION_CONTRACT.descendant;
  let auditMergeContent = options.auditMergeContent;
  if (auditMergeContent === undefined) {
    // Fail before any provider read when the merge-tree audit cannot run.
    requiredEnvironment(env, ["RELEASE_DESCENDANT_GIT_DIR"]);
    const gitDir = env.RELEASE_DESCENDANT_GIT_DIR;
    auditMergeContent = (input) => auditDescendantMergeContent({ gitDir, ...input });
  }
  const { initialMainSha, controller, controllerRelease } = await readRetainedReleaseController(
    api,
    context,
  );
  const candidate = assertCommit(
    await api.get(repositoryPath(`/git/commits/${context.sourceSha}`)),
    context.sourceSha,
    "release candidate commit",
  );

  // Exact Version provenance: unchanged merged-PR, merge-event, reviewed
  // base/head, retention, source-admission and topology/full-delta proofs.
  const {
    source: provenance,
    pull,
    pullNumber,
    pullIdentity,
  } = await readMergedReleasePull(api, context.provenanceSha, "Version provenance");
  assertVersionProvenancePull(pull);
  const controllerIsReviewedBase = context.controllerSha === pullIdentity.baseSha;
  if (!controllerIsReviewedBase) {
    await assertSourceAncestorOfCurrentMain(
      api,
      context.sourceSha,
      context.controllerSha,
      "release controller",
      "release candidate",
    );
    await assertSourceAncestorOfCurrentMain(
      api,
      context.controllerSha,
      initialMainSha,
      "initial release main",
      "release controller",
    );
  }
  const [base, head] = await Promise.all([
    api
      .get(repositoryPath(`/git/commits/${pullIdentity.baseSha}`))
      .then((value) => assertCommit(value, pullIdentity.baseSha, "reviewed base commit")),
    api
      .get(repositoryPath(`/git/commits/${pullIdentity.headSha}`))
      .then((value) => assertCommit(value, pullIdentity.headSha, "reviewed head commit")),
  ]);
  if (controllerIsReviewedBase) {
    invariant(
      controller.treeSha === base.treeSha,
      "release controller tree differs from the exact reviewed base tree",
    );
  }
  const { mergeMethod, sourceComposition } = await classifyReleaseSourceComposition(
    api,
    provenance,
    base,
    head,
    pullIdentity,
  );
  invariant(
    limits.supportedProvenanceMergeMethods.includes(mergeMethod),
    `Version provenance ${mergeMethod} is not a true merge commit retaining the reviewed head`,
  );
  const review = mergedSourceReview(pullNumber, context.provenanceSha, pullIdentity);
  const releaseHeadTag = releaseHeadTagName(pullIdentity.headSha);
  const [headChecks, releaseHeadRef, releaseHeadReleaseValue] = await Promise.all([
    paginatedCheckRuns(api, pullIdentity.headSha),
    api.get(repositoryPath(`/git/ref/tags/${releaseHeadTag}`)),
    api.get(repositoryPath(`/releases/tags/${releaseHeadTag}`)),
  ]);
  assertReleaseHeadRef(releaseHeadRef, pullIdentity.headSha);
  const releaseHeadRelease = assertReleaseHeadRelease(
    releaseHeadReleaseValue,
    pullIdentity.headSha,
  );
  const sourceAdmission = await verifyDurableSourceAdmission({
    api,
    checks: headChecks,
    pull,
    pullNumber,
    baseSha: pullIdentity.baseSha,
    headSha: pullIdentity.headSha,
    token: context.token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    logger,
  });

  // Descendant topology and content: provider ancestry, intervening PR
  // provenance, retained Version content and an independent merge-tree audit.
  const firstParentMerges = await readDescendantFirstParentMerges(
    api,
    context.provenanceSha,
    context.sourceSha,
  );
  const candidateEntry = firstParentMerges.at(-1);
  invariant(
    candidateEntry?.sha === context.sourceSha &&
      candidateEntry.treeSha === candidate.treeSha &&
      candidateEntry.parents.length === candidate.parents.length &&
      candidateEntry.parents.every((parent, index) => parent === candidate.parents[index]),
    "release candidate commit differs from its descendant ancestry evidence",
  );
  const interveningMerges = [];
  for (const merge of firstParentMerges) {
    interveningMerges.push(await verifyInterveningMergePull(api, merge));
  }
  const versionContent = await verifyVersionContentRetained(api, base, head, candidate);
  const mergeContent = verifyMergeContentAudit(
    await auditMergeContent({
      provenanceSha: context.provenanceSha,
      candidateSha: context.sourceSha,
    }),
    provenance,
    firstParentMerges,
    context.sourceSha,
  );

  // Every CI, image and receipt fact is bound to the released candidate only.
  const candidateChecks = await paginatedCheckRuns(api, context.sourceSha);
  const requiredSourceChecks = await verifySuccessfulSourceChecks(
    api,
    candidateChecks,
    [
      ...RELEASE_AUTOMATION_CONTRACT.checks.requiredSource,
      ...RELEASE_AUTOMATION_CONTRACT.checks.fullGreenJobs,
    ],
    context.sourceSha,
  );
  const { workflowRunId, workflowRunAttempt } = requiredSourceChecks[0];
  const fullGreenStatus = await verifyFullGreenStatus(
    api,
    context.sourceSha,
    workflowRunId,
    workflowRunAttempt,
  );
  const fullGreenArtifacts = await verifyFullGreenArtifacts(
    api,
    context.sourceSha,
    workflowRunId,
    workflowRunAttempt,
  );

  const terminalMain = await api.get(repositoryPath("/git/ref/heads/main"));
  const terminalMainSha = await assertReleaseMainRef(
    api,
    terminalMain,
    context.sourceSha,
    "terminal release main",
  );
  if (!controllerIsReviewedBase) {
    await assertSourceAncestorOfCurrentMain(
      api,
      context.controllerSha,
      terminalMainSha,
      "terminal release main",
      "release controller",
    );
  }

  const releaseHead = {
    name: releaseHeadTag,
    ref: `refs/tags/${releaseHeadTag}`,
    sha: pullIdentity.headSha,
  };
  const result = {
    version: 3,
    admissionMode: "tested-descendant",
    repository: RELEASE_AUTOMATION_CONTRACT.repository,
    sourceSha: context.sourceSha,
    sourceTreeSha: candidate.treeSha,
    sourceParents: candidate.parents,
    controller: {
      sha: context.controllerSha,
      treeSha: controller.treeSha,
      release: controllerRelease,
    },
    pullRequestNumber: pullNumber,
    reviewedHeadSha: pullIdentity.headSha,
    review,
    versionProvenance: {
      sha: context.provenanceSha,
      treeSha: provenance.treeSha,
      parents: provenance.parents,
      pullRequestNumber: pullNumber,
      mergeMethod,
      sourceComposition,
      providerPullCommitCount: pullIdentity.commitCount,
      mergedAt: new Date(pullIdentity.mergedAt).toISOString(),
      reviewedBaseSha: pullIdentity.baseSha,
      reviewedBaseTreeSha: base.treeSha,
      reviewedHeadSha: pullIdentity.headSha,
      reviewedHeadTreeSha: head.treeSha,
      releaseHead,
      releaseHeadRelease,
      review,
      sourceAdmission,
      retainedContent: versionContent,
    },
    descendant: {
      interveningMerges,
      interveningMergesSha256: mergeListSha256(interveningMerges),
      mergeContent,
    },
    requiredSourceChecks,
    fullGreen: {
      workflowRunId,
      workflowRunAttempt,
      status: fullGreenStatus,
      artifacts: fullGreenArtifacts,
    },
  };
  logger.log(
    `Verified Version PR #${pullNumber} provenance ${context.provenanceSha} and fully green ` +
      `descendant ${context.sourceSha} across ${interveningMerges.length} audited merges.`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Version-head release ("merge-version-head").
//
// A reviewed, green bot Version PR stays releasable when it lands as a
// two-parent merge commit M: its merge result can carry changesets merged to
// main after the Version base, while its exact head S cannot. The released
// source is S itself. M is used only to prove that S landed on main through
// exactly that Version PR; M's tree is never release content. Source CI is the
// exact-head Automation PR CI run, which executes on main at the Version base
// and is bound to S by its provider-authored report-job log.
// ---------------------------------------------------------------------------

const versionHeadIdentityError =
  "release source is a merged pull-request head, not its merge result; " +
  "only the bot Version PR head may be released from its merge commit";

export function automationCiReportBinding(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Automation PR CI report job log is not valid UTF-8");
  }
  text = text.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const payloads = lines.map((line) => {
    const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z (.*)$/.exec(line);
    invariant(match !== null, "Automation PR CI report job log framing is invalid");
    // Strip ANSI styling the runner adds to echoed commands.
    // eslint-disable-next-line no-control-regex
    return match[1].replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  });
  const exactIndexes = (value) =>
    payloads.flatMap((payload, index) => (payload === value ? [index] : []));
  const jobNameIndexes = exactIndexes(
    `Complete job name: ${RELEASE_AUTOMATION_CONTRACT.checks.automationCiReportJob}`,
  );
  const groupIndexes = exactIndexes(
    "##[group]Run node scripts/check-release-pr-automation.mjs complete-version-check",
  );
  invariant(
    jobNameIndexes.length === 1 && groupIndexes.length === 1,
    "Automation PR CI report job log lacks one exact-head completion step",
  );
  const groupEndIndex = payloads.indexOf("##[endgroup]", groupIndexes[0] + 1);
  invariant(
    groupEndIndex > 0,
    "Automation PR CI report job log lacks one exact-head completion step",
  );
  const group = payloads.slice(groupIndexes[0] + 1, groupEndIndex);
  const envIndexes = group.flatMap((payload, index) => (payload === "env:" ? [index] : []));
  invariant(
    envIndexes.length === 1,
    "Automation PR CI report step environment is missing or ambiguous",
  );
  const env = new Map();
  for (const payload of group.slice(envIndexes[0] + 1)) {
    const match = /^ {2}([A-Z][A-Z0-9_]*): (.*)$/.exec(payload);
    invariant(
      match !== null && !env.has(match[1]),
      "Automation PR CI report step environment is malformed",
    );
    env.set(match[1], match[2]);
  }
  const pullText = env.get("AUTOMATION_PR_NUMBER") ?? "";
  const headSha = env.get("AUTOMATION_HEAD_SHA") ?? "";
  const baseSha = env.get("AUTOMATION_BASE_SHA") ?? "";
  invariant(
    positiveIntegerPattern.test(pullText) &&
      Number.isSafeInteger(Number(pullText)) &&
      shaPattern.test(headSha) &&
      shaPattern.test(baseSha) &&
      headSha !== baseSha,
    "Automation PR CI report step does not record an exact-head completion",
  );
  return {
    pullNumber: Number(pullText),
    headSha,
    baseSha,
    checkKind: env.get("AUTOMATION_CHECK_KIND") ?? "",
    checkConclusion: env.get("AUTOMATION_CHECK_CONCLUSION") ?? "",
    clean: payloads.every((payload) => !payload.startsWith("##[error]")),
    logSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function exactAutomationCiJob(jobs, name, run, baseSha) {
  const selected = jobs.filter((job) => job?.name === name);
  invariant(selected.length === 1, `Automation PR CI job ${name} is not unique`);
  const job = selected[0];
  const jobId = assertPositiveInteger(job?.id, `Automation PR CI job ${name} ID`);
  invariant(
    job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      job.head_sha === baseSha &&
      job.head_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch &&
      job.html_url ===
        `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
          `/actions/runs/${run.id}/job/${jobId}` &&
      job.check_run_url ===
        `${RELEASE_AUTOMATION_CONTRACT.apiUrl}/repos/${RELEASE_AUTOMATION_CONTRACT.repository}` +
          `/check-runs/${jobId}`,
    `Automation PR CI job ${name} is not successfully bound`,
  );
  return { job, jobId };
}

async function verifyVersionHeadAutomationCi(api, { checks, pullNumber, headSha, baseSha }) {
  const name = RELEASE_AUTOMATION_CONTRACT.checks.automationCi;
  const externalId = checkIdentity("automation-ci", { prNumber: pullNumber, headSha }).externalId;
  const named = checks.filter((check) => check?.name === name);
  invariant(
    named.length > 0,
    "exact-head Automation PR CI check is missing for the Version PR head",
  );
  invariant(
    named.length === 1 && named[0]?.external_id === externalId,
    "exact-head Automation PR CI check is not unique or not bound to the exact Version PR head",
  );
  assertSuccessfulCheckRun(named[0], name, headSha, externalId);
  const checkRunId = assertPositiveInteger(named[0].id, "Automation PR CI check-run ID");

  const listing = record(
    await api.get(
      repositoryPath(
        `/actions/workflows/${RELEASE_AUTOMATION_CONTRACT.ciWorkflowFile}/runs` +
          `?branch=${RELEASE_AUTOMATION_CONTRACT.defaultBranch}&event=workflow_dispatch` +
          `&head_sha=${baseSha}&per_page=${recordsPerPage}&page=1`,
      ),
    ),
    "Automation PR CI run listing",
  );
  invariant(
    Array.isArray(listing.workflow_runs) &&
      listing.total_count === listing.workflow_runs.length &&
      listing.workflow_runs.length < recordsPerPage,
    "Automation PR CI run listing is incomplete",
  );
  const successful = listing.workflow_runs.filter(
    (run) => run?.status === "completed" && run?.conclusion === "success",
  );
  invariant(successful.length > 0, "no successful Automation PR CI run exists at the Version base");
  invariant(
    successful.length <= RELEASE_AUTOMATION_CONTRACT.versionHead.maximumAutomationCiRuns,
    "successful Automation PR CI runs at the Version base exceed the bounded listing",
  );
  // Other green dispatch runs can share the Version base (for example an
  // earlier head regenerated on the same base). A run counts only when its
  // report log binds this exact PR, head and base; every bound run must then
  // pass the full strict checks, and the newest is recorded.
  const bound = [];
  for (const run of successful) {
    const id = assertPositiveInteger(run.id, "Automation PR CI run ID");
    const attempt = assertPositiveInteger(run.run_attempt, "Automation PR CI run attempt");
    invariant(
      run.path === RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath &&
        run.event === "workflow_dispatch" &&
        run.head_branch === RELEASE_AUTOMATION_CONTRACT.defaultBranch &&
        run.head_sha === baseSha &&
        run.repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository &&
        run.head_repository?.full_name === RELEASE_AUTOMATION_CONTRACT.repository &&
        run.html_url ===
          `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
            `/actions/runs/${id}`,
      "Automation PR CI run is not the trusted main workflow at the Version base",
    );
    const jobs = await paginatedWorkflowAttemptJobs(api, id, attempt);
    const reportJobs = jobs.filter(
      (job) => job?.name === RELEASE_AUTOMATION_CONTRACT.checks.automationCiReportJob,
    );
    invariant(
      reportJobs.length === 1,
      `Automation PR CI job ${RELEASE_AUTOMATION_CONTRACT.checks.automationCiReportJob} is not unique`,
    );
    // A run whose report job did not succeed cannot bind any head.
    if (reportJobs[0]?.status !== "completed" || reportJobs[0]?.conclusion !== "success") continue;
    const binding = automationCiReportBinding(
      await api.jobLogBytes(
        assertPositiveInteger(reportJobs[0].id, "Automation PR CI report job ID"),
        RELEASE_AUTOMATION_CONTRACT.versionHead.maximumReportLogBytes,
      ),
    );
    if (
      binding.pullNumber !== pullNumber ||
      binding.headSha !== headSha ||
      binding.baseSha !== baseSha
    ) {
      continue;
    }
    invariant(
      binding.clean &&
        binding.checkKind === "automation-ci" &&
        binding.checkConclusion === "success",
      "Automation PR CI report step does not record a successful exact-head completion",
    );
    bound.push({ run, jobs, reportLogSha256: binding.logSha256 });
  }
  invariant(
    bound.length > 0,
    "no successful Automation PR CI run is bound to the exact Version PR head",
  );
  const verified = bound.map(({ run, jobs, reportLogSha256 }) => {
    const report = exactAutomationCiJob(
      jobs,
      RELEASE_AUTOMATION_CONTRACT.checks.automationCiReportJob,
      run,
      baseSha,
    );
    const reportSteps = (Array.isArray(report.job.steps) ? report.job.steps : []).filter(
      (step) => step?.name === RELEASE_AUTOMATION_CONTRACT.checks.automationCiReportStep,
    );
    invariant(
      reportSteps.length === 1 &&
        reportSteps[0].status === "completed" &&
        reportSteps[0].conclusion === "success",
      "Automation PR CI report job did not complete the exact-head check",
    );
    const admission = exactAutomationCiJob(
      jobs,
      RELEASE_AUTOMATION_CONTRACT.checks.automationCiAdmissionJob,
      run,
      baseSha,
    );
    const required = RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((jobName) => ({
      name: jobName,
      jobId: exactAutomationCiJob(jobs, jobName, run, baseSha).jobId,
    }));
    return { run, report, admission, required, reportLogSha256 };
  });
  const selected = verified.reduce((newest, candidate) =>
    candidate.run.id > newest.run.id ? candidate : newest,
  );
  return {
    requiredSourceChecks: selected.required.map(({ name: jobName, jobId }) =>
      Object.freeze({
        name: jobName,
        appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
        appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
        workflowRunId: selected.run.id,
        workflowRunAttempt: selected.run.run_attempt,
        workflowJobId: jobId,
      }),
    ),
    automationCi: {
      name,
      sha: headSha,
      checkRunId,
      externalId,
      workflowPath: RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
      workflowEvent: "workflow_dispatch",
      workflowSha: baseSha,
      workflowRunId: selected.run.id,
      workflowRunAttempt: selected.run.run_attempt,
      admissionJobId: selected.admission.jobId,
      reportJobId: selected.report.jobId,
      reportJobLogSha256: selected.reportLogSha256,
    },
  };
}

async function assertNoPendingChangesets(api, tree) {
  const root = record(
    await api.get(repositoryPath(`/git/trees/${tree.treeSha}`)),
    "Version-head release source tree",
  );
  invariant(
    root.sha === tree.treeSha && root.truncated === false && Array.isArray(root.tree),
    "Version-head release source tree listing is incomplete",
  );
  const changesetDirectories = root.tree.filter((entry) => entry?.path === ".changeset");
  invariant(changesetDirectories.length <= 1, "Version-head release source tree is ambiguous");
  if (changesetDirectories.length === 0) return;
  const directory = changesetDirectories[0];
  invariant(directory.type === "tree", "Version-head .changeset entry is not a directory");
  const directorySha = assertSha(directory.sha, "Version-head .changeset tree SHA");
  const listing = record(
    await api.get(repositoryPath(`/git/trees/${directorySha}`)),
    "Version-head .changeset tree",
  );
  invariant(
    listing.sha === directorySha && listing.truncated === false && Array.isArray(listing.tree),
    "Version-head .changeset tree listing is incomplete",
  );
  const pending = listing.tree.filter((entry) => {
    const path = assertString(entry?.path, "Version-head .changeset entry path");
    return entry.type === "blob" && path.endsWith(".md") && path !== "README.md";
  });
  invariant(
    pending.length === 0,
    `Version-head release source still contains ${pending.length} pending changeset(s)`,
  );
}

async function verifyVersionHeadRelease({
  options,
  logger,
  context,
  api,
  initialMainSha,
  controller,
  controllerRelease,
  merged,
}) {
  const { source, associatedPull, pullNumber } = merged;
  const mergeCommitSha = assertSha(associatedPull.merge_commit_sha, "Version PR merge commit SHA");
  invariant(mergeCommitSha !== context.sourceSha, "Version PR merge commit equals its head");
  const pull = record(await api.get(repositoryPath(`/pulls/${pullNumber}`)), "pull-request detail");
  const pullIdentity = assertMergedPull(pull, { pullNumber, sourceSha: mergeCommitSha });
  invariant(
    associatedPull.base?.sha === pullIdentity.baseSha &&
      associatedPull.head?.sha === pullIdentity.headSha,
    "associated pull summary differs from pull-request detail",
  );
  try {
    assertVersionProvenancePull(pull);
  } catch {
    throw new Error(versionHeadIdentityError);
  }
  invariant(
    pullIdentity.headSha === context.sourceSha,
    "Version-head release source is not the exact Version PR head",
  );
  invariant(
    pullIdentity.commitCount === 1 && source.parents.length === 1,
    "Version-head release source is not one generated commit on its Version base",
  );
  const versionBaseSha = source.parents[0];
  // The provider PR base can have advanced past the generated commit's parent;
  // the reviewed patch must still be exactly that one commit on its parent.
  const comparison = await api.get(
    repositoryPath(`/compare/${pullIdentity.baseSha}...${context.sourceSha}`),
  );
  invariant(
    comparison?.base_commit?.sha === pullIdentity.baseSha &&
      comparison?.merge_base_commit?.sha === versionBaseSha &&
      comparison?.ahead_by === 1 &&
      comparison?.total_commits === 1 &&
      Array.isArray(comparison?.commits) &&
      comparison.commits.length === 1 &&
      comparison.commits[0]?.sha === context.sourceSha,
    "Version-head release source is not directly on its reviewed patch base",
  );

  const mergeCommit = assertCommit(
    await api.get(repositoryPath(`/git/commits/${mergeCommitSha}`)),
    mergeCommitSha,
    "Version PR merge commit",
  );
  invariant(
    mergeCommit.parents.length === 2 &&
      mergeCommit.parents[1] === context.sourceSha &&
      mergeCommit.parents[0] !== context.sourceSha,
    "release source is not the second parent of the Version PR merge commit",
  );
  const mergePulls = await paginatedArray(
    api,
    repositoryPath(`/commits/${mergeCommitSha}/pulls`),
    "Version PR merge commit associated pull requests",
  );
  invariant(
    mergePulls.length === 1 &&
      mergePulls[0]?.number === pullNumber &&
      mergePulls[0]?.merge_commit_sha === mergeCommitSha &&
      mergePulls[0]?.head?.sha === context.sourceSha,
    "Version PR merge commit is not associated with exactly one pull request",
  );
  const timeline = await paginatedArray(
    api,
    repositoryPath(`/issues/${pullNumber}/timeline`),
    "pull-request timeline",
  );
  assertProviderMergeEvent(timeline, mergeCommitSha, pullIdentity);
  await assertSourceAncestorOfCurrentMain(
    api,
    mergeCommitSha,
    initialMainSha,
    "initial release main",
    "Version PR merge commit",
  );

  const controllerIsReviewedBase = context.controllerSha === pullIdentity.baseSha;
  if (!controllerIsReviewedBase) {
    await assertSourceAncestorOfCurrentMain(
      api,
      context.sourceSha,
      context.controllerSha,
      "release controller",
      "admitted source",
    );
    await assertSourceAncestorOfCurrentMain(
      api,
      context.controllerSha,
      initialMainSha,
      "initial release main",
      "release controller",
    );
  }
  const base = assertCommit(
    await api.get(repositoryPath(`/git/commits/${pullIdentity.baseSha}`)),
    pullIdentity.baseSha,
    "reviewed base commit",
  );
  if (controllerIsReviewedBase) {
    invariant(
      controller.treeSha === base.treeSha,
      "release controller tree differs from the exact reviewed base tree",
    );
  }
  await assertNoPendingChangesets(api, source);
  const review = mergedSourceReview(pullNumber, context.sourceSha, pullIdentity);

  const releaseHeadTag = releaseHeadTagName(context.sourceSha);
  const [headChecks, releaseHeadRef, releaseHeadReleaseValue] = await Promise.all([
    paginatedCheckRuns(api, context.sourceSha),
    api.get(repositoryPath(`/git/ref/tags/${releaseHeadTag}`)),
    api.get(repositoryPath(`/releases/tags/${releaseHeadTag}`)),
  ]);
  assertReleaseHeadRef(releaseHeadRef, context.sourceSha);
  const releaseHeadRelease = assertReleaseHeadRelease(releaseHeadReleaseValue, context.sourceSha);
  const sourceAdmission = await verifyDurableSourceAdmission({
    api,
    checks: headChecks,
    pull,
    pullNumber,
    baseSha: pullIdentity.baseSha,
    headSha: context.sourceSha,
    token: context.token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    logger,
  });
  const { requiredSourceChecks, automationCi } = await verifyVersionHeadAutomationCi(api, {
    checks: headChecks,
    pullNumber,
    headSha: context.sourceSha,
    baseSha: versionBaseSha,
  });

  const terminalMain = await api.get(repositoryPath("/git/ref/heads/main"));
  const terminalMainSha = await assertReleaseMainRef(
    api,
    terminalMain,
    context.sourceSha,
    "terminal release main",
  );
  await assertSourceAncestorOfCurrentMain(
    api,
    mergeCommitSha,
    terminalMainSha,
    "terminal release main",
    "Version PR merge commit",
  );
  if (!controllerIsReviewedBase) {
    await assertSourceAncestorOfCurrentMain(
      api,
      context.controllerSha,
      terminalMainSha,
      "terminal release main",
      "release controller",
    );
  }

  const provenance = {
    version: 2,
    admissionMode: RELEASE_AUTOMATION_CONTRACT.versionHead.mergeMethod,
    repository: RELEASE_AUTOMATION_CONTRACT.repository,
    sourceSha: context.sourceSha,
    sourceTreeSha: source.treeSha,
    sourceParents: source.parents,
    controller: {
      sha: context.controllerSha,
      treeSha: controller.treeSha,
      release: controllerRelease,
    },
    pullRequestNumber: pullNumber,
    mergeMethod: RELEASE_AUTOMATION_CONTRACT.versionHead.mergeMethod,
    sourceComposition: {
      type: "version-head-released-from-merge-commit",
      versionBaseSha,
      mergeCommitSha,
      mergeCommitTreeSha: mergeCommit.treeSha,
      mergeCommitParents: mergeCommit.parents,
    },
    providerPullCommitCount: pullIdentity.commitCount,
    mergedAt: new Date(pullIdentity.mergedAt).toISOString(),
    reviewedBaseSha: pullIdentity.baseSha,
    reviewedBaseTreeSha: base.treeSha,
    reviewedHeadSha: context.sourceSha,
    reviewedHeadTreeSha: source.treeSha,
    releaseHead: {
      name: releaseHeadTag,
      ref: `refs/tags/${releaseHeadTag}`,
      sha: context.sourceSha,
    },
    releaseHeadRelease,
    review,
    sourceAdmission,
    requiredSourceChecks,
    automationCi,
  };
  logger.log(
    `Verified Version PR #${pullNumber} head ${context.sourceSha} released from its merge ` +
      `commit ${mergeCommitSha} with exact-head Automation PR CI.`,
  );
  return provenance;
}

export async function verifyApprovedMerge(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const context = releaseApprovalContext(env, options.sourceSha, options.provenanceSha);
  const api = githubClient(options.fetchImpl ?? globalThis.fetch, context.token);
  if (context.descendant) {
    return verifyTestedDescendantRelease({ options, env, logger, context, api });
  }
  const { initialMainSha, controller, controllerRelease } = await readRetainedReleaseController(
    api,
    context,
  );
  const merged = await readMergedReleasePull(api, context.sourceSha, "release source", {
    allowVersionHead: true,
  });
  if (merged.versionHead) {
    return verifyVersionHeadRelease({
      options,
      logger,
      context,
      api,
      initialMainSha,
      controller,
      controllerRelease,
      merged,
    });
  }
  const { source, pull, pullNumber, pullIdentity } = merged;
  const controllerIsReviewedBase = context.controllerSha === pullIdentity.baseSha;
  if (!controllerIsReviewedBase) {
    await assertSourceAncestorOfCurrentMain(
      api,
      context.sourceSha,
      context.controllerSha,
      "release controller",
      "admitted source",
    );
    await assertSourceAncestorOfCurrentMain(
      api,
      context.controllerSha,
      initialMainSha,
      "initial release main",
      "release controller",
    );
  }
  const [base, head] = await Promise.all([
    api
      .get(repositoryPath(`/git/commits/${pullIdentity.baseSha}`))
      .then((value) => assertCommit(value, pullIdentity.baseSha, "reviewed base commit")),
    api
      .get(repositoryPath(`/git/commits/${pullIdentity.headSha}`))
      .then((value) => assertCommit(value, pullIdentity.headSha, "reviewed head commit")),
  ]);
  if (controllerIsReviewedBase) {
    invariant(
      controller.treeSha === base.treeSha,
      "release controller tree differs from the exact reviewed base tree",
    );
  }
  const { mergeMethod, sourceComposition } = await classifyReleaseSourceComposition(
    api,
    source,
    base,
    head,
    pullIdentity,
  );
  // When GitHub's merge-time `pull.base.sha` has advanced past the reviewed
  // patch base, no exact-head Version CI ran against the landed integration
  // base. Admit that shape only for one generated Version commit on its patch
  // base, and only with the landed commit's own fully green push run (below).
  const advancedProviderBase =
    sourceComposition.type === "exact-reviewed-delta-on-moving-main" &&
    sourceComposition.patchBaseSha !== pullIdentity.baseSha;
  if (advancedProviderBase) {
    assertVersionProvenancePull(pull);
    invariant(
      pullIdentity.commitCount === 1 &&
        head.parents.length === 1 &&
        head.parents[0] === sourceComposition.patchBaseSha,
      "advanced-provider-base release head is not one generated commit on its patch base",
    );
  }
  const review = mergedSourceReview(pullNumber, context.sourceSha, pullIdentity);

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
  const sourceAdmission = await verifyDurableSourceAdmission({
    api,
    checks: headChecks,
    pull,
    pullNumber,
    baseSha: pullIdentity.baseSha,
    headSha: pullIdentity.headSha,
    token: context.token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    logger,
  });
  const requiredSourceChecks = await verifySuccessfulSourceChecks(
    api,
    sourceChecks,
    advancedProviderBase
      ? [
          ...RELEASE_AUTOMATION_CONTRACT.checks.requiredSource,
          ...RELEASE_AUTOMATION_CONTRACT.checks.fullGreenJobs,
        ]
      : RELEASE_AUTOMATION_CONTRACT.checks.requiredSource,
    context.sourceSha,
  );
  let fullGreen;
  if (advancedProviderBase) {
    const { workflowRunId, workflowRunAttempt } = requiredSourceChecks[0];
    fullGreen = {
      workflowRunId,
      workflowRunAttempt,
      status: await verifyFullGreenStatus(
        api,
        context.sourceSha,
        workflowRunId,
        workflowRunAttempt,
      ),
      artifacts: await verifyFullGreenArtifacts(
        api,
        context.sourceSha,
        workflowRunId,
        workflowRunAttempt,
      ),
    };
  }
  const terminalMain = await api.get(repositoryPath("/git/ref/heads/main"));
  const terminalMainSha = await assertReleaseMainRef(
    api,
    terminalMain,
    context.sourceSha,
    "terminal release main",
  );
  if (!controllerIsReviewedBase) {
    await assertSourceAncestorOfCurrentMain(
      api,
      context.controllerSha,
      terminalMainSha,
      "terminal release main",
      "release controller",
    );
  }

  const provenance = {
    version: 2,
    repository: RELEASE_AUTOMATION_CONTRACT.repository,
    sourceSha: context.sourceSha,
    sourceTreeSha: source.treeSha,
    sourceParents: source.parents,
    controller: {
      sha: context.controllerSha,
      treeSha: controller.treeSha,
      release: controllerRelease,
    },
    pullRequestNumber: pullNumber,
    mergeMethod,
    sourceComposition,
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
    review,
    sourceAdmission,
    requiredSourceChecks,
    ...(fullGreen ? { fullGreen } : {}),
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
  if (command === "retain-release-controller") {
    const result = await retainCurrentMainControllerEvidence({ env });
    writeOutputs(
      {
        release_controller_sha: result.controllerSha,
        release_controller_ref: result.releaseHead.ref,
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
        release_source_sha: result.sourceSha,
        version_provenance_sha: result.versionProvenance?.sha ?? result.sourceSha,
        release_admission_mode: result.admissionMode ?? "exact-source",
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
