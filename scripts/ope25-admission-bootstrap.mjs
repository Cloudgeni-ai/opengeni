import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT = Object.freeze({
  apiUrl: "https://api.github.com",
  serverUrl: "https://github.com",
  repository: "Cloudgeni-ai/opengeni",
  owner: "Cloudgeni-ai",
  defaultBranch: "main",
  dispatcherLogin: "jorgensandhaug",
  dispatcherId: "55702375",
  originalMainSha: "d64797027ef578190f563783c4908e6ac2fa353e",
  originalTreeSha: "6882878011386dc9c0a1de147c2c4a308284a7e2",
  bootstrapPullRequestNumber: 506,
  bootstrapHeadBranch: "feat/ope25-admission-bootstrap",
  bootstrapTitle: "chore: add exact OPE-25 admission bootstrap",
  reviewedCandidateSha: "fb3b151fdc5f188af001004e11e03fdb2ba290a6",
  reviewedCandidateTreeSha: "808290ab3174a7b22bc5d6f7bb06c0d2bf6a2a2e",
  headBranch: "ope25-admission-governance-v2",
  workflowPath: ".github/workflows/ope25-admission-bootstrap.yml",
  helperPath: "scripts/ope25-admission-bootstrap.mjs",
  testPath: "scripts/ope25-admission-bootstrap.test.ts",
  marker: "ope25-admission-governance-pr:v2",
  title: "chore: restore exact OPE-25 admission tree (v2)",
});

export const REVIEWED_CANDIDATE_BLOBS = Object.freeze({
  [CONTRACT.workflowPath]: "71ccf0091ac1562ffc81f2f4fdfcaacb699ea418",
  [CONTRACT.helperPath]: "921567a843c133fee47f6f3e521c9cc369c5dc37",
  [CONTRACT.testPath]: "449943810df5f3b0095ff0c298e35390bcc459bd",
});

export const TEMPORARY_PATHS = Object.freeze(
  [CONTRACT.workflowPath, CONTRACT.helperPath, CONTRACT.testPath].sort(compareCodeUnits),
);

const shaPattern = /^[0-9a-f]{40}$/;

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class ManualInterventionError extends Error {
  constructor(number, verificationError, cleanupError) {
    super(
      `OPE25_BOOTSTRAP_MANUAL_INTERVENTION: created PR #${number} failed verification (` +
        `${errorMessage(verificationError)}) and automatic closure/readback failed (` +
        `${errorMessage(cleanupError)}). Close only PR #${number} manually and do not rerun ` +
        `marker ${CONTRACT.marker}.`,
      { cause: cleanupError },
    );
    this.name = "ManualInterventionError";
    this.code = "OPE25_BOOTSTRAP_MANUAL_INTERVENTION";
    this.pullRequestNumber = number;
    this.verificationError = verificationError;
    this.cleanupError = cleanupError;
  }
}

function assertSha(value, label) {
  invariant(
    typeof value === "string" && shaPattern.test(value),
    `${label} is not a lowercase Git SHA`,
  );
  return value;
}

function expectedContext(env) {
  const required = [
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
    "GITHUB_API_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_TOKEN",
    "GITHUB_TRIGGERING_ACTOR",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "OPENGENI_BOOTSTRAP_ACTION",
  ];
  for (const name of required)
    invariant(typeof env[name] === "string" && env[name].length > 0, `${name} is missing`);
  invariant(
    env.OPENGENI_BOOTSTRAP_ACTION === "open_exact_governance_pr",
    "unexpected workflow action identity",
  );
  invariant(env.GITHUB_ACTOR === CONTRACT.dispatcherLogin, "unexpected workflow dispatcher");
  invariant(
    env.GITHUB_TRIGGERING_ACTOR === CONTRACT.dispatcherLogin,
    "unexpected triggering actor",
  );
  invariant(env.GITHUB_ACTOR_ID === CONTRACT.dispatcherId, "unexpected workflow dispatcher ID");
  invariant(env.GITHUB_API_URL === CONTRACT.apiUrl, "unexpected GitHub API origin");
  invariant(env.GITHUB_SERVER_URL === CONTRACT.serverUrl, "unexpected GitHub server origin");
  invariant(env.GITHUB_EVENT_NAME === "workflow_dispatch", "unexpected workflow event");
  invariant(env.GITHUB_REPOSITORY === CONTRACT.repository, "unexpected repository");
  invariant(
    env.GITHUB_REF === `refs/heads/${CONTRACT.defaultBranch}`,
    "workflow was not dispatched from main",
  );
  invariant(env.GITHUB_REF_NAME === CONTRACT.defaultBranch, "unexpected workflow ref name");
  invariant(
    env.GITHUB_WORKFLOW_REF ===
      `${CONTRACT.repository}/${CONTRACT.workflowPath}@refs/heads/${CONTRACT.defaultBranch}`,
    "unexpected workflow ref",
  );
  const baseSha = assertSha(env.GITHUB_SHA, "GITHUB_SHA");
  invariant(
    env.GITHUB_WORKFLOW_SHA === baseSha,
    "workflow source SHA differs from the dispatch SHA",
  );
  return { baseSha, token: env.GITHUB_TOKEN };
}

function apiClient(fetchImpl, token) {
  invariant(typeof fetchImpl === "function", "fetch implementation is missing");
  return async function request(path, options = {}) {
    invariant(typeof path === "string" && path.startsWith("/"), "GitHub API path is invalid");
    const method = options.method ?? "GET";
    const response = await fetchImpl(`${CONTRACT.apiUrl}${path}`, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "opengeni-ope25-admission-bootstrap",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok)
      throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}`);
    return response.json();
  };
}

function assertRepository(value) {
  invariant(value?.full_name === CONTRACT.repository, "repository identity changed");
  invariant(
    value?.owner?.login === CONTRACT.owner && value.owner.type === "Organization",
    "repository owner changed",
  );
  invariant(value?.default_branch === CONTRACT.defaultBranch, "default branch changed");
  invariant(
    value?.archived === false && value?.disabled === false,
    "repository is archived or disabled",
  );
  invariant(value?.private === false, "repository visibility changed");
}

function assertRef(value, expectedRef, label) {
  invariant(value?.ref === expectedRef, `${label} ref changed`);
  invariant(value?.object?.type === "commit", `${label} does not resolve directly to a commit`);
  return assertSha(value.object.sha, `${label} SHA`);
}

function assertCommit(value, expectedSha, label) {
  invariant(value?.sha === expectedSha, `${label} identity changed`);
  const treeSha = assertSha(value?.tree?.sha, `${label} tree SHA`);
  invariant(Array.isArray(value?.parents), `${label} parents are missing`);
  const parents = value.parents.map((parent, index) =>
    assertSha(parent?.sha, `${label} parent ${index}`),
  );
  return { treeSha, parents };
}

function canonicalLeafMap(value, expectedSha, label) {
  invariant(value?.sha === expectedSha, `${label} identity changed`);
  invariant(value?.truncated === false, `${label} is truncated`);
  invariant(Array.isArray(value?.tree), `${label} entries are missing`);
  const out = new Map();
  for (const entry of value.tree) {
    if (entry?.type === "tree") continue;
    invariant(
      typeof entry.path === "string" && entry.path.length > 0,
      `${label} has an invalid path`,
    );
    invariant(
      entry.type === "blob" || entry.type === "commit",
      `${label} has an unexpected leaf type: ${entry.path}`,
    );
    invariant(!out.has(entry.path), `${label} has a duplicate path`);
    out.set(entry.path, {
      mode: entry.mode,
      type: entry.type,
      sha: assertSha(entry.sha, `${label} object ${entry.path}`),
    });
  }
  return out;
}

export function assertTemporaryBaseTree(originalValue, temporaryValue, temporaryTreeSha) {
  const original = canonicalLeafMap(originalValue, CONTRACT.originalTreeSha, "original tree");
  const temporary = canonicalLeafMap(temporaryValue, temporaryTreeSha, "temporary base tree");
  const paths = [...new Set([...original.keys(), ...temporary.keys()])].sort(compareCodeUnits);
  const changed = paths.filter(
    (path) =>
      JSON.stringify(original.get(path) ?? null) !== JSON.stringify(temporary.get(path) ?? null),
  );
  invariant(
    JSON.stringify(changed) === JSON.stringify(TEMPORARY_PATHS),
    "temporary base changes more than the bootstrap files",
  );
  for (const path of TEMPORARY_PATHS) {
    invariant(!original.has(path), `temporary path already exists in the original tree: ${path}`);
    const entry = temporary.get(path);
    invariant(
      entry?.mode === "100644" && entry.type === "blob",
      `temporary path is not a regular non-executable blob: ${path}`,
    );
  }
}

function assertReviewedCandidateTree(value) {
  const reviewed = canonicalLeafMap(
    value,
    CONTRACT.reviewedCandidateTreeSha,
    "reviewed candidate tree",
  );
  for (const path of TEMPORARY_PATHS) {
    const entry = reviewed.get(path);
    invariant(
      entry?.mode === "100644" &&
        entry.type === "blob" &&
        entry.sha === REVIEWED_CANDIDATE_BLOBS[path],
      `reviewed candidate blob changed: ${path}`,
    );
  }
}

function assertBootstrapPullRequest(value, baseSha, candidateHeadSha) {
  invariant(
    value?.number === CONTRACT.bootstrapPullRequestNumber,
    "bootstrap source pull-request number changed",
  );
  invariant(
    value?.state === "closed" && value?.merged === true,
    "bootstrap source pull request is not merged",
  );
  invariant(
    typeof value?.merged_at === "string" && value.merged_at.length > 0,
    "bootstrap source merge timestamp is missing",
  );
  invariant(value?.merge_commit_sha === baseSha, "bootstrap source merge SHA differs from B");
  invariant(
    value?.title === CONTRACT.bootstrapTitle,
    "bootstrap source pull-request title changed",
  );
  invariant(
    value?.user?.login === CONTRACT.dispatcherLogin && value.user.type === "User",
    "bootstrap source pull-request author changed",
  );
  invariant(
    value?.merged_by?.login === CONTRACT.dispatcherLogin && value.merged_by.type === "User",
    "bootstrap source pull-request merger changed",
  );
  invariant(
    value?.base?.ref === CONTRACT.defaultBranch &&
      value.base.sha === CONTRACT.originalMainSha &&
      value.base.repo?.full_name === CONTRACT.repository,
    "bootstrap source pull-request base changed",
  );
  invariant(
    value?.head?.ref === CONTRACT.bootstrapHeadBranch &&
      value.head.sha === candidateHeadSha &&
      value.head.repo?.full_name === CONTRACT.repository,
    "bootstrap source pull-request head changed",
  );
  invariant(
    value?.commits === 2 && value?.changed_files === TEMPORARY_PATHS.length,
    "bootstrap source pull-request commit or file count changed",
  );
}

async function inspectSourceIdentity(api, baseSha) {
  const repository = await api(`/repos/${CONTRACT.repository}`);
  assertRepository(repository);

  const mainRef = await api(
    `/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.defaultBranch}`,
  );
  invariant(
    assertRef(mainRef, `refs/heads/${CONTRACT.defaultBranch}`, "default branch") === baseSha,
    "current main differs from this workflow run",
  );

  const baseCommitValue = await api(`/repos/${CONTRACT.repository}/git/commits/${baseSha}`);
  const baseCommit = assertCommit(baseCommitValue, baseSha, "temporary base commit");
  invariant(baseCommit.parents.length === 2, "temporary base is not a two-parent merge");
  invariant(
    baseCommit.parents[0] === CONTRACT.originalMainSha,
    "temporary base does not descend directly from the authorized main",
  );
  const candidateHeadSha = baseCommit.parents[1];

  const [bootstrapPullRequest, originalCommitValue, reviewedCommitValue, candidateCommitValue] =
    await Promise.all([
      api(`/repos/${CONTRACT.repository}/pulls/${CONTRACT.bootstrapPullRequestNumber}`),
      api(`/repos/${CONTRACT.repository}/git/commits/${CONTRACT.originalMainSha}`),
      api(`/repos/${CONTRACT.repository}/git/commits/${CONTRACT.reviewedCandidateSha}`),
      api(`/repos/${CONTRACT.repository}/git/commits/${candidateHeadSha}`),
    ]);
  assertBootstrapPullRequest(bootstrapPullRequest, baseSha, candidateHeadSha);
  const originalCommit = assertCommit(
    originalCommitValue,
    CONTRACT.originalMainSha,
    "authorized original commit",
  );
  invariant(
    originalCommit.treeSha === CONTRACT.originalTreeSha,
    "authorized original commit tree changed",
  );
  const reviewedCommit = assertCommit(
    reviewedCommitValue,
    CONTRACT.reviewedCandidateSha,
    "reviewed candidate commit",
  );
  invariant(
    reviewedCommit.parents.length === 1 && reviewedCommit.parents[0] === CONTRACT.originalMainSha,
    "reviewed candidate is not one commit on the authorized main",
  );
  invariant(
    reviewedCommit.treeSha === CONTRACT.reviewedCandidateTreeSha,
    "reviewed candidate commit tree changed",
  );
  const candidateCommit = assertCommit(
    candidateCommitValue,
    candidateHeadSha,
    "corrected candidate commit",
  );
  invariant(
    candidateCommit.parents.length === 1 &&
      candidateCommit.parents[0] === CONTRACT.reviewedCandidateSha,
    "corrected candidate is not one fix commit on the reviewed candidate",
  );
  invariant(
    candidateCommit.treeSha === baseCommit.treeSha,
    "temporary merge tree differs from the corrected candidate tree",
  );

  const [originalTree, reviewedTree, temporaryTree] = await Promise.all([
    api(`/repos/${CONTRACT.repository}/git/trees/${CONTRACT.originalTreeSha}?recursive=1`),
    api(`/repos/${CONTRACT.repository}/git/trees/${CONTRACT.reviewedCandidateTreeSha}?recursive=1`),
    api(`/repos/${CONTRACT.repository}/git/trees/${baseCommit.treeSha}?recursive=1`),
  ]);
  assertTemporaryBaseTree(originalTree, reviewedTree, CONTRACT.reviewedCandidateTreeSha);
  assertReviewedCandidateTree(reviewedTree);
  assertTemporaryBaseTree(originalTree, temporaryTree, baseCommit.treeSha);

  const headRef = await api(`/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.headBranch}`);
  const headSha = assertRef(headRef, `refs/heads/${CONTRACT.headBranch}`, "governance head");
  const headCommitValue = await api(`/repos/${CONTRACT.repository}/git/commits/${headSha}`);
  const headCommit = assertCommit(headCommitValue, headSha, "governance head commit");
  invariant(
    headCommit.parents.length === 1 && headCommit.parents[0] === baseSha,
    "governance head is not one commit on the temporary base",
  );
  invariant(
    headCommit.treeSha === CONTRACT.originalTreeSha,
    "governance head does not restore the exact original tree",
  );
  return { baseSha, headSha, temporaryTreeSha: baseCommit.treeSha, candidateHeadSha };
}

function canonicalPullRequestBody(identity) {
  return [
    `<!-- ${CONTRACT.marker} -->`,
    "",
    "This draft PR is the single-use provider-owned governance edge for OPE-25 ordinary-release admission.",
    "",
    `- temporary base \`B\`: \`${identity.baseSha}\``,
    `- governance head \`H\`: \`${identity.headSha}\``,
    `- required final tree \`T\`: \`${CONTRACT.originalTreeSha}\``,
    `- removed temporary paths: ${TEMPORARY_PATHS.map((path) => `\`${path}\``).join(", ")}`,
    "",
    "`H` has sole parent `B` and restores `T` exactly. Do not update, rebase, squash, retarget, or reuse this PR. The eventual merge must be a two-parent merge commit with first parent `B`, second parent `H`, and tree `T`.",
    "",
    "GitHub may hold workflows triggered by a `GITHUB_TOKEN`-created PR for repository approval instead of running them automatically. Do not rely on that initial event. After this workflow succeeds, an explicitly authorized human must close and reopen this same draft PR using a human token as the deterministic fallback. The natural `reopened` provider event is covered by `.github/workflows/ci.yml`'s existing `pull_request` trigger and does not change `H` or bot authorship. Before any review, verify the PR author is still `github-actions[bot]`, the head is still `H`, and the exact-H `Typecheck and unit tests`, `Deployment artifacts`, and `Workload image builds` jobs are terminal-successful.",
    "",
    "Independent Sol/xhigh review and canonical-v2 provider approval remain mandatory. This PR is not release authorization.",
  ].join("\n");
}

async function listAllPullRequests(api) {
  const out = [];
  for (let page = 1; page <= 30; page += 1) {
    const value = await api(
      `/repos/${CONTRACT.repository}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    invariant(Array.isArray(value), "pull-request listing is invalid");
    out.push(...value);
    if (value.length < 100) return out;
  }
  throw new Error("pull-request listing exceeded 3000 records");
}

function equivalentPullRequests(pulls) {
  return pulls.filter(
    (pull) =>
      pull?.head?.ref === CONTRACT.headBranch ||
      pull?.title === CONTRACT.title ||
      (typeof pull?.body === "string" && pull.body.includes(`<!-- ${CONTRACT.marker} -->`)),
  );
}

async function listPullRequestFiles(api, number) {
  const out = [];
  for (let page = 1; page <= 30; page += 1) {
    const value = await api(
      `/repos/${CONTRACT.repository}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    invariant(Array.isArray(value), "pull-request file listing is invalid");
    out.push(...value);
    if (value.length < 100) return out;
  }
  throw new Error("pull-request file listing exceeded 3000 records");
}

async function assertCanonicalPullRequest(api, pull, identity, expectedBody) {
  invariant(
    Number.isSafeInteger(pull?.number) && pull.number > 0,
    "pull-request number is invalid",
  );
  invariant(
    pull?.state === "open" && pull?.draft === true,
    "bootstrap pull request is not an open draft",
  );
  invariant(
    pull?.title === CONTRACT.title && pull?.body === expectedBody,
    "bootstrap pull-request title or body changed",
  );
  invariant(
    pull?.user?.login === "github-actions[bot]" && pull.user.type === "Bot",
    "bootstrap pull request is not provider-authored by github-actions[bot]",
  );
  invariant(
    pull?.base?.ref === CONTRACT.defaultBranch && pull.base.sha === identity.baseSha,
    "bootstrap pull-request base changed",
  );
  invariant(
    pull?.base?.repo?.full_name === CONTRACT.repository,
    "bootstrap pull-request base repository changed",
  );
  invariant(
    pull?.head?.ref === CONTRACT.headBranch && pull.head.sha === identity.headSha,
    "bootstrap pull-request head changed",
  );
  invariant(
    pull?.head?.repo?.full_name === CONTRACT.repository,
    "bootstrap pull-request head repository changed",
  );
  invariant(
    pull?.maintainer_can_modify === false,
    "maintainer modification was unexpectedly enabled",
  );
  invariant(
    pull?.commits === 1 && pull?.changed_files === TEMPORARY_PATHS.length,
    "bootstrap pull-request commit or file count changed",
  );
  const files = await listPullRequestFiles(api, pull.number);
  const observed = files
    .map((file) => ({ filename: file?.filename, status: file?.status }))
    .sort((left, right) => compareCodeUnits(left.filename, right.filename));
  const expected = TEMPORARY_PATHS.map((filename) => ({ filename, status: "removed" }));
  invariant(
    JSON.stringify(observed) === JSON.stringify(expected),
    "bootstrap pull request does not remove exactly the temporary paths",
  );
}

async function assertRefsUnchanged(api, identity) {
  const [mainRef, headRef] = await Promise.all([
    api(`/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.defaultBranch}`),
    api(`/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.headBranch}`),
  ]);
  invariant(
    assertRef(mainRef, `refs/heads/${CONTRACT.defaultBranch}`, "default branch") ===
      identity.baseSha,
    "default branch drifted during bootstrap",
  );
  invariant(
    assertRef(headRef, `refs/heads/${CONTRACT.headBranch}`, "governance head") === identity.headSha,
    "governance head drifted during bootstrap",
  );
}

async function closeAndProveCreatedPullRequest(api, number) {
  const path = `/repos/${CONTRACT.repository}/pulls/${number}`;
  const patched = await api(path, { method: "PATCH", body: { state: "closed" } });
  invariant(
    patched?.number === number && patched?.state === "closed",
    "cleanup PATCH did not close the created pull request",
  );
  const readback = await api(path);
  invariant(readback?.number === number, "cleanup readback returned a different pull request");
  invariant(
    readback?.state === "closed" && readback?.merged === false,
    "cleanup readback did not prove the created pull request closed and unmerged",
  );
}

async function verifyCreatedPullRequest(api, number, identity, expectedBody) {
  const pull = await api(`/repos/${CONTRACT.repository}/pulls/${number}`);
  await assertCanonicalPullRequest(api, pull, identity, expectedBody);
  await assertRefsUnchanged(api, identity);
  const finalMatches = equivalentPullRequests(await listAllPullRequests(api));
  invariant(
    finalMatches.length === 1 && finalMatches[0]?.number === number,
    "created bootstrap pull request is not globally unique",
  );
}

export async function runBootstrap(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const { baseSha, token } = expectedContext(env);
  const api = apiClient(options.fetchImpl ?? globalThis.fetch, token);
  const identity = await inspectSourceIdentity(api, baseSha);
  const expectedBody = canonicalPullRequestBody(identity);

  const initialMatches = equivalentPullRequests(await listAllPullRequests(api));
  if (initialMatches.length > 0) {
    invariant(initialMatches.length === 1, "multiple equivalent bootstrap pull requests exist");
    const existing = await api(`/repos/${CONTRACT.repository}/pulls/${initialMatches[0].number}`);
    invariant(
      existing?.state === "open",
      `equivalent bootstrap PR #${existing?.number ?? "unknown"} is closed; marker ` +
        `${CONTRACT.marker} is terminal and must not be retried`,
    );
    await assertCanonicalPullRequest(api, existing, identity, expectedBody);
    await assertRefsUnchanged(api, identity);
    const finalMatches = equivalentPullRequests(await listAllPullRequests(api));
    invariant(
      finalMatches.length === 1 && finalMatches[0]?.number === existing.number,
      "existing bootstrap pull request is not globally unique",
    );
    await assertRefsUnchanged(api, identity);
    logger.log(`Canonical bootstrap PR #${existing.number} already exists; no mutation performed.`);
    return { action: "existing", number: existing.number, ...identity };
  }

  await assertRefsUnchanged(api, identity);
  invariant(
    equivalentPullRequests(await listAllPullRequests(api)).length === 0,
    "an equivalent pull request appeared before creation",
  );
  await assertRefsUnchanged(api, identity);

  const created = await api(`/repos/${CONTRACT.repository}/pulls`, {
    method: "POST",
    body: {
      title: CONTRACT.title,
      body: expectedBody,
      head: `${CONTRACT.owner}:${CONTRACT.headBranch}`,
      base: CONTRACT.defaultBranch,
      draft: true,
      maintainer_can_modify: false,
    },
  });
  invariant(
    Number.isSafeInteger(created?.number) && created.number > 0,
    "GitHub did not return the created pull-request number",
  );
  try {
    await verifyCreatedPullRequest(api, created.number, identity, expectedBody);
  } catch (verificationError) {
    try {
      await closeAndProveCreatedPullRequest(api, created.number);
    } catch (cleanupError) {
      throw new ManualInterventionError(created.number, verificationError, cleanupError);
    }
    throw new Error(
      `Created bootstrap PR #${created.number} failed verification and was closed. ` +
        `Marker ${CONTRACT.marker} is terminal and must not be retried. Original failure: ` +
        errorMessage(verificationError),
      { cause: verificationError },
    );
  }
  logger.log(
    `Created canonical draft bootstrap PR #${created.number} at exact head ${identity.headSha}.`,
  );
  return { action: "created", number: created.number, ...identity };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runBootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
