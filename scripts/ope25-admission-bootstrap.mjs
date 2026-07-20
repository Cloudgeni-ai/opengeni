import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  bootstrapCommitCount: 5,
  reviewedPredecessorSha: "2533a78996c074818ab9a213b711b5b864841813",
  reviewedPredecessorTreeSha: "29165e658e734cfbcc70f18058cc68f80878ddde",
  headBranch: "ope25-admission-governance-v2",
  workflowPath: ".github/workflows/ope25-admission-bootstrap.yml",
  helperPath: "scripts/ope25-admission-bootstrap.mjs",
  testPath: "scripts/ope25-admission-bootstrap.test.ts",
  marker: "ope25-admission-governance-pr:v2",
  title: "chore: restore exact OPE-25 admission tree (v2)",
});

export const SOURCE_PREDECESSOR_CHAIN = Object.freeze([
  Object.freeze({
    sha: "fb3b151fdc5f188af001004e11e03fdb2ba290a6",
    treeSha: "808290ab3174a7b22bc5d6f7bb06c0d2bf6a2a2e",
    parentSha: CONTRACT.originalMainSha,
  }),
  Object.freeze({
    sha: "3c8eb5a29d1ea69d97b25482c5637754bf77b0c7",
    treeSha: "2ba1ced55ec1a1a00d4474169c0420951284ffad",
    parentSha: "fb3b151fdc5f188af001004e11e03fdb2ba290a6",
  }),
  Object.freeze({
    sha: "d778b49a1aac5e9e2998f5c9e2b1d88d2bb1ac28",
    treeSha: "3d69fba60dc77c13cebe2d159503d0eabb3585d1",
    parentSha: "3c8eb5a29d1ea69d97b25482c5637754bf77b0c7",
  }),
  Object.freeze({
    sha: CONTRACT.reviewedPredecessorSha,
    treeSha: CONTRACT.reviewedPredecessorTreeSha,
    parentSha: "d778b49a1aac5e9e2998f5c9e2b1d88d2bb1ac28",
  }),
]);

export const REVIEWED_PREDECESSOR_BLOBS = Object.freeze({
  [CONTRACT.workflowPath]: "c09d5e56018ee788c6bfdf1fe0cd2e8a48bbdd4f",
  [CONTRACT.helperPath]: "cc1d949f1c5f057befea0075b44f10f34a45f412",
  [CONTRACT.testPath]: "2168a6c55cc5a77efe74e6ae4be261a82fce3c10",
});

export const TEMPORARY_PATHS = Object.freeze(
  [CONTRACT.workflowPath, CONTRACT.helperPath, CONTRACT.testPath].sort(compareCodeUnits),
);

const shaPattern = /^[0-9a-f]{40}$/;
const CANONICAL_WORKFLOW_SHA256 =
  "ed08126b8a29eca5d7dd9f6a52cfa5b1091cc3e67d3a6a962c33e7c9fbd31f91";
const EXPECTED_TEST_SHA256 = "17dcd104bf24e39efa48216b0d07ba22c31b3a9a8c0d6d8301c8d1e636fc29ee";
const HELPER_DIGEST_SENTINEL = "0".repeat(64);
const MAX_PULL_REQUEST_PAGES = 30;
const PULL_REQUESTS_PER_PAGE = 100;
const STABLE_LIST_ATTEMPTS = 3;

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

export class AmbiguousCreationError extends Error {
  constructor(postError, observation) {
    super(
      `OPE25_BOOTSTRAP_MANUAL_INTERVENTION: pull-request POST outcome is ambiguous ` +
        `(${errorMessage(postError)}); ${observation}. Do not retry the POST or rerun marker ` +
        `${CONTRACT.marker}; inspect provider state and resolve manually.`,
      { cause: postError },
    );
    this.name = "AmbiguousCreationError";
    this.code = "OPE25_BOOTSTRAP_MANUAL_INTERVENTION";
    this.postError = postError;
    this.observation = observation;
  }
}

function assertSha(value, label) {
  invariant(
    typeof value === "string" && shaPattern.test(value),
    `${label} is not a lowercase Git SHA`,
  );
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function runningHelperBytes() {
  return readFileSync(fileURLToPath(import.meta.url));
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

function assertReviewedPredecessorTree(value) {
  const predecessor = canonicalLeafMap(
    value,
    CONTRACT.reviewedPredecessorTreeSha,
    "reviewed predecessor tree",
  );
  for (const path of TEMPORARY_PATHS) {
    const entry = predecessor.get(path);
    invariant(
      entry?.mode === "100644" &&
        entry.type === "blob" &&
        entry.sha === REVIEWED_PREDECESSOR_BLOBS[path],
      `reviewed predecessor blob changed: ${path}`,
    );
  }
}

function assertFinalCandidateDelta(predecessorValue, candidateValue, candidateTreeSha) {
  const predecessor = canonicalLeafMap(
    predecessorValue,
    CONTRACT.reviewedPredecessorTreeSha,
    "reviewed predecessor tree",
  );
  const candidate = canonicalLeafMap(candidateValue, candidateTreeSha, "final candidate tree");
  const paths = [...new Set([...predecessor.keys(), ...candidate.keys()])].sort(compareCodeUnits);
  const changed = paths.filter(
    (path) =>
      JSON.stringify(predecessor.get(path) ?? null) !== JSON.stringify(candidate.get(path) ?? null),
  );
  invariant(
    JSON.stringify(changed) === JSON.stringify(TEMPORARY_PATHS),
    "final correction does not change exactly the bootstrap files",
  );
  for (const path of TEMPORARY_PATHS) {
    const entry = candidate.get(path);
    invariant(
      entry?.mode === "100644" &&
        entry.type === "blob" &&
        entry.sha !== REVIEWED_PREDECESSOR_BLOBS[path],
      `final candidate did not replace the reviewed predecessor blob: ${path}`,
    );
  }
  return candidate;
}

async function readExactGitBlob(api, sha, label) {
  const value = await api(`/repos/${CONTRACT.repository}/git/blobs/${sha}`);
  invariant(value?.sha === sha, `${label} API blob identity changed`);
  invariant(value?.encoding === "base64", `${label} API blob encoding changed`);
  invariant(
    Number.isSafeInteger(value?.size) && value.size >= 0,
    `${label} API blob size is invalid`,
  );
  invariant(typeof value?.content === "string", `${label} API blob content is missing`);
  invariant(!value.content.includes("\r"), `${label} API base64 transport is non-canonical`);
  const encoded = value.content.replaceAll("\n", "");
  invariant(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
    `${label} API base64 transport is invalid`,
  );
  const bytes = Buffer.from(encoded, "base64");
  invariant(bytes.toString("base64") === encoded, `${label} API base64 transport is ambiguous`);
  invariant(bytes.length === value.size, `${label} API blob size changed`);
  invariant(gitBlobSha(bytes) === sha, `${label} API blob bytes differ from its Git identity`);
  return bytes;
}

function decodeExactUtf8(bytes, label) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    invariant(Buffer.from(text, "utf8").equals(bytes), `${label} UTF-8 encoding is ambiguous`);
    return text;
  } catch (error) {
    throw new Error(`${label} is not exact UTF-8: ${errorMessage(error)}`, { cause: error });
  }
}

async function assertExactCandidateSource(api, candidate) {
  // Authorized boundary: independently reviewed, provider-read, SHA-fenced workflow/helper
  // bytes are fixed before exact-B dispatch. This running helper is therefore the external
  // verifier anchor for API-observed source bytes; this is not universal self-authentication.
  const entries = Object.fromEntries(
    TEMPORARY_PATHS.map((path) => {
      const entry = candidate.get(path);
      invariant(entry?.type === "blob", `final candidate source is not a blob: ${path}`);
      return [path, entry];
    }),
  );
  const [workflowBytes, observedHelperBytes, testBytes] = await Promise.all([
    readExactGitBlob(api, entries[CONTRACT.workflowPath].sha, "API-observed bootstrap workflow"),
    readExactGitBlob(api, entries[CONTRACT.helperPath].sha, "API-observed bootstrap helper"),
    readExactGitBlob(api, entries[CONTRACT.testPath].sha, "API-observed bootstrap test"),
  ]);

  const fixedHelperBytes = runningHelperBytes();
  invariant(
    observedHelperBytes.equals(fixedHelperBytes),
    "API-observed helper bytes differ from the fixed running verifier",
  );

  const fixedHelperSha256 = sha256(fixedHelperBytes);
  const workflow = decodeExactUtf8(workflowBytes, "API-observed bootstrap workflow");
  const helperDigestLine = /^(      BOOTSTRAP_HELPER_SHA256: )([0-9a-f]{64})\n/gm;
  const matches = [...workflow.matchAll(helperDigestLine)];
  invariant(
    matches.length === 1,
    "API-observed bootstrap workflow helper digest field is not unique and canonical",
  );
  invariant(
    matches[0][2] === fixedHelperSha256,
    "API-observed bootstrap workflow does not pin the fixed running verifier",
  );
  const canonicalWorkflow = workflow.replace(helperDigestLine, `$1${HELPER_DIGEST_SENTINEL}\n`);
  invariant(
    sha256(canonicalWorkflow) === CANONICAL_WORKFLOW_SHA256,
    "API-observed bootstrap workflow bytes changed",
  );
  invariant(
    sha256(testBytes) === EXPECTED_TEST_SHA256,
    "API-observed bootstrap test bytes changed",
  );
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
    value?.commits === CONTRACT.bootstrapCommitCount,
    "bootstrap source pull-request commit count changed",
  );
  invariant(
    value?.changed_files === TEMPORARY_PATHS.length,
    "bootstrap source pull-request file count changed",
  );
}

export async function inspectSourceIdentity(api, baseSha) {
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

  const [bootstrapPullRequest, originalCommitValue, predecessorCommitValues, candidateCommitValue] =
    await Promise.all([
      api(`/repos/${CONTRACT.repository}/pulls/${CONTRACT.bootstrapPullRequestNumber}`),
      api(`/repos/${CONTRACT.repository}/git/commits/${CONTRACT.originalMainSha}`),
      Promise.all(
        SOURCE_PREDECESSOR_CHAIN.map(({ sha }) =>
          api(`/repos/${CONTRACT.repository}/git/commits/${sha}`),
        ),
      ),
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
  for (const [index, expected] of SOURCE_PREDECESSOR_CHAIN.entries()) {
    const predecessorCommit = assertCommit(
      predecessorCommitValues[index],
      expected.sha,
      `source predecessor commit ${index + 1}`,
    );
    invariant(
      predecessorCommit.parents.length === 1 && predecessorCommit.parents[0] === expected.parentSha,
      `source predecessor commit ${index + 1} parent changed`,
    );
    invariant(
      predecessorCommit.treeSha === expected.treeSha,
      `source predecessor commit ${index + 1} tree changed`,
    );
  }
  const candidateCommit = assertCommit(
    candidateCommitValue,
    candidateHeadSha,
    "corrected candidate commit",
  );
  invariant(
    candidateCommit.parents.length === 1 &&
      candidateCommit.parents[0] === CONTRACT.reviewedPredecessorSha,
    "final candidate is not the sole fifth commit on the reviewed predecessor",
  );
  invariant(
    candidateCommit.treeSha === baseCommit.treeSha,
    "temporary merge tree differs from the final candidate tree",
  );

  const [originalTree, predecessorTree, temporaryTree] = await Promise.all([
    api(`/repos/${CONTRACT.repository}/git/trees/${CONTRACT.originalTreeSha}?recursive=1`),
    api(
      `/repos/${CONTRACT.repository}/git/trees/${CONTRACT.reviewedPredecessorTreeSha}?recursive=1`,
    ),
    api(`/repos/${CONTRACT.repository}/git/trees/${baseCommit.treeSha}?recursive=1`),
  ]);
  assertTemporaryBaseTree(originalTree, predecessorTree, CONTRACT.reviewedPredecessorTreeSha);
  assertReviewedPredecessorTree(predecessorTree);
  assertTemporaryBaseTree(originalTree, temporaryTree, baseCommit.treeSha);
  const candidate = assertFinalCandidateDelta(predecessorTree, temporaryTree, baseCommit.treeSha);
  await assertExactCandidateSource(api, candidate);

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

async function listAllPullRequestsOnce(api) {
  const out = [];
  const numbers = new Set();
  for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
    const value = await api(
      `/repos/${CONTRACT.repository}/pulls?state=all&sort=created&direction=asc&` +
        `per_page=${PULL_REQUESTS_PER_PAGE}&page=${page}`,
    );
    invariant(Array.isArray(value), "pull-request listing is invalid");
    for (const pull of value) {
      invariant(
        Number.isSafeInteger(pull?.number) && pull.number > 0,
        "pull-request listing contains an invalid number",
      );
      invariant(!numbers.has(pull.number), "pull-request listing contains a duplicate number");
      numbers.add(pull.number);
      out.push(pull);
    }
    if (value.length < PULL_REQUESTS_PER_PAGE) return out;
  }
  throw new Error("pull-request listing exceeded 3000 records");
}

function pullRequestListFingerprint(pulls) {
  return JSON.stringify(
    pulls.map((pull) => ({
      number: pull.number,
      state: pull?.state ?? null,
      title: pull?.title ?? null,
      body: pull?.body ?? null,
      headRef: pull?.head?.ref ?? null,
      headSha: pull?.head?.sha ?? null,
    })),
  );
}

async function listAllPullRequests(api) {
  // The fail-closed observation contract is two identical, completed projections in immutable
  // ascending creation order. This catches insertions during pagination; no finite REST read
  // sequence can prove that provider state will remain unchanged after its terminal read.
  let previousFingerprint;
  for (let attempt = 1; attempt <= STABLE_LIST_ATTEMPTS; attempt += 1) {
    const pulls = await listAllPullRequestsOnce(api);
    const fingerprint = pullRequestListFingerprint(pulls);
    if (fingerprint === previousFingerprint) return pulls;
    previousFingerprint = fingerprint;
  }
  throw new Error("pull-request listing did not reach two identical ascending snapshots");
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
  await assertRefsUnchanged(api, identity);
  const terminalPull = await api(`/repos/${CONTRACT.repository}/pulls/${number}`);
  await assertCanonicalPullRequest(api, terminalPull, identity, expectedBody);
  await assertRefsUnchanged(api, identity);
}

async function failCreatedPullRequest(api, number, verificationError) {
  try {
    await closeAndProveCreatedPullRequest(api, number);
  } catch (cleanupError) {
    throw new ManualInterventionError(number, verificationError, cleanupError);
  }
  throw new Error(
    `Created bootstrap PR #${number} failed verification and was closed. ` +
      `Marker ${CONTRACT.marker} is terminal and must not be retried. Original failure: ` +
      errorMessage(verificationError),
    { cause: verificationError },
  );
}

export async function runBootstrap(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const { baseSha, token } = expectedContext(env);
  const api = apiClient(options.fetchImpl ?? globalThis.fetch, token);
  const identity = await inspectSourceIdentity(api, baseSha);
  const expectedBody = canonicalPullRequestBody(identity);

  const initialPulls = await listAllPullRequests(api);
  const initialMatches = equivalentPullRequests(initialPulls);
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
    const terminalExisting = await api(`/repos/${CONTRACT.repository}/pulls/${existing.number}`);
    await assertCanonicalPullRequest(api, terminalExisting, identity, expectedBody);
    await assertRefsUnchanged(api, identity);
    logger.log(`Canonical bootstrap PR #${existing.number} already exists; no mutation performed.`);
    return { action: "existing", number: existing.number, ...identity };
  }

  await assertRefsUnchanged(api, identity);
  const preCreationPulls = await listAllPullRequests(api);
  invariant(
    equivalentPullRequests(preCreationPulls).length === 0,
    "an equivalent pull request appeared before creation",
  );
  await assertRefsUnchanged(api, identity);

  let created;
  let postError;
  try {
    const response = await api(`/repos/${CONTRACT.repository}/pulls`, {
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
      Number.isSafeInteger(response?.number) && response.number > 0,
      "GitHub did not return the created pull-request number",
    );
    created = response;
  } catch (error) {
    postError = error;
  }

  let postCreationPulls;
  try {
    postCreationPulls = await listAllPullRequests(api);
  } catch (listError) {
    throw new AmbiguousCreationError(
      postError ?? new Error("POST returned but provider reconciliation failed"),
      `the post-POST inventory failed (${errorMessage(listError)})`,
    );
  }
  const previousNumbers = new Set(preCreationPulls.map((pull) => pull.number));
  const newPulls = postCreationPulls.filter((pull) => !previousNumbers.has(pull.number));
  const newEquivalentPulls = equivalentPullRequests(newPulls);
  if (newPulls.length !== 1 || newEquivalentPulls.length !== 1) {
    throw new AmbiguousCreationError(
      postError ?? new Error("POST returned without a unique inventory delta"),
      `the stable post-POST inventory contains ${newPulls.length} newly observed pull requests ` +
        `and ${newEquivalentPulls.length} match an exact creation discriminator`,
    );
  }
  const createdNumber = newEquivalentPulls[0].number;
  if (created && created.number !== createdNumber) {
    throw new AmbiguousCreationError(
      new Error(`POST returned PR #${created.number}`),
      `the sole newly observed pull request is #${createdNumber}`,
    );
  }

  try {
    await verifyCreatedPullRequest(api, createdNumber, identity, expectedBody);
  } catch (verificationError) {
    await failCreatedPullRequest(api, createdNumber, verificationError);
  }
  logger.log(
    `Created canonical draft bootstrap PR #${createdNumber} at exact head ${identity.headSha}.`,
  );
  return {
    action: "created",
    number: createdNumber,
    reconciledAmbiguousPost: postError !== undefined,
    ...identity,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runBootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
