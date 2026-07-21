import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CONTRACT = Object.freeze({
  action: "verify_current_base_head",
  apiUrl: "https://api.github.com",
  serverUrl: "https://github.com",
  repository: "Cloudgeni-ai/opengeni",
  owner: "Cloudgeni-ai",
  defaultBranch: "main",
  workflowPath: ".github/workflows/source-admission.yml",
  helperPath: "scripts/check-source-admission.mjs",
  testPath: "scripts/check-source-admission.test.ts",
});

const shaPattern = /^[0-9a-f]{40}$/;
const allowedActions = new Set(["opened", "ready_for_review", "reopened", "synchronize"]);
const allowedFileStatuses = new Set([
  "added",
  "changed",
  "copied",
  "modified",
  "removed",
  "renamed",
]);
const allowedBlobModes = new Set(["100644", "100755", "120000"]);
const maxFilePages = 30;
const filesPerPage = 100;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSha(value, label) {
  invariant(
    typeof value === "string" && shaPattern.test(value),
    `${label} is not a lowercase Git SHA`,
  );
  return value;
}

function assertString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is invalid`,
  );
  return value;
}

function readEvent(env) {
  const path = assertString(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `GitHub event payload is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  return record(parsed, "GitHub event payload");
}

function expectedContext(env, suppliedEvent) {
  const required = [
    "GITHUB_API_URL",
    "GITHUB_BASE_REF",
    "GITHUB_EVENT_NAME",
    "GITHUB_HEAD_REF",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_TOKEN",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "OPENGENI_SOURCE_ADMISSION_ACTION",
  ];
  for (const name of required) assertString(env[name], name);

  invariant(
    env.OPENGENI_SOURCE_ADMISSION_ACTION === CONTRACT.action,
    "unexpected admission action identity",
  );
  invariant(env.GITHUB_API_URL === CONTRACT.apiUrl, "unexpected GitHub API origin");
  invariant(env.GITHUB_SERVER_URL === CONTRACT.serverUrl, "unexpected GitHub server origin");
  invariant(env.GITHUB_EVENT_NAME === "pull_request_target", "unexpected workflow event");
  invariant(env.GITHUB_REPOSITORY === CONTRACT.repository, "unexpected repository");
  invariant(env.GITHUB_BASE_REF === CONTRACT.defaultBranch, "unexpected base branch");
  invariant(env.GITHUB_REF === `refs/heads/${CONTRACT.defaultBranch}`, "unexpected workflow ref");
  invariant(
    env.GITHUB_WORKFLOW_REF ===
      `${CONTRACT.repository}/${CONTRACT.workflowPath}@refs/heads/${CONTRACT.defaultBranch}`,
    "unexpected workflow source ref",
  );

  const workflowSha = assertSha(env.GITHUB_WORKFLOW_SHA, "GITHUB_WORKFLOW_SHA");
  invariant(
    assertSha(env.GITHUB_SHA, "GITHUB_SHA") === workflowSha,
    "workflow SHA differs from the base event SHA",
  );

  const event =
    suppliedEvent === undefined ? readEvent(env) : record(suppliedEvent, "GitHub event payload");
  invariant(allowedActions.has(event.action), "unexpected pull-request action");
  invariant(
    record(event.repository, "event repository").full_name === CONTRACT.repository,
    "event repository changed",
  );
  const pull = record(event.pull_request, "event pull request");
  invariant(
    Number.isSafeInteger(event.number) && event.number > 0,
    "event pull-request number is invalid",
  );
  invariant(pull.number === event.number, "event pull-request numbers disagree");
  invariant(pull.state === "open", "event pull request is not open");

  const base = record(pull.base, "event pull-request base");
  const head = record(pull.head, "event pull-request head");
  invariant(base.ref === CONTRACT.defaultBranch, "event pull-request base branch changed");
  invariant(
    record(base.repo, "event base repository").full_name === CONTRACT.repository,
    "event base repository changed",
  );
  invariant(env.GITHUB_BASE_REF === base.ref, "event base ref differs from the environment");
  invariant(env.GITHUB_HEAD_REF === head.ref, "event head ref differs from the environment");
  const headRepository = assertString(
    record(head.repo, "event head repository").full_name,
    "event head repository identity",
  );

  return {
    event,
    number: event.number,
    eventBaseSha: assertSha(base.sha, "event base SHA"),
    eventHeadSha: assertSha(head.sha, "event head SHA"),
    headRepository,
    token: env.GITHUB_TOKEN,
    workflowSha,
  };
}

function apiClient(fetchImpl, token) {
  invariant(typeof fetchImpl === "function", "fetch implementation is missing");
  return async function request(path) {
    invariant(typeof path === "string" && path.startsWith("/"), "GitHub API path is invalid");
    const response = await fetchImpl(`${CONTRACT.apiUrl}${path}`, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "opengeni-source-admission",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    invariant(
      response?.ok === true,
      `GitHub API GET ${path} failed with HTTP ${response?.status ?? "unknown"}`,
    );
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
  for (const [index, parent] of value.parents.entries())
    assertSha(parent?.sha, `${label} parent ${index}`);
  return treeSha;
}

function assertPullRequest(value, expected) {
  invariant(value?.number === expected.number, "pull-request number changed");
  invariant(value?.state === "open", "pull request is not open");
  invariant(value?.base?.ref === CONTRACT.defaultBranch, "pull-request base branch changed");
  invariant(
    value?.base?.repo?.full_name === CONTRACT.repository,
    "pull-request base repository changed",
  );
  invariant(value?.base?.sha === expected.baseSha, "pull-request base SHA changed");
  invariant(value?.head?.ref === expected.headRef, "pull-request head branch changed");
  invariant(value?.head?.sha === expected.headSha, "pull-request head SHA changed");
  invariant(
    value?.head?.repo?.full_name === expected.headRepository,
    "pull-request head repository changed",
  );
  invariant(
    Number.isSafeInteger(value?.commits) && value.commits > 0,
    "pull-request commit count is invalid",
  );
  invariant(
    Number.isSafeInteger(value?.changed_files) &&
      value.changed_files > 0 &&
      value.changed_files <= maxFilePages * filesPerPage,
    "pull-request changed-file count is invalid",
  );
}

function canonicalLeafMap(value, expectedSha, label) {
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
        allowedBlobModes.has(entry.mode),
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

export function directTreeManifest(base, head) {
  invariant(base instanceof Map && head instanceof Map, "tree maps are missing");
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort(compareCodeUnits);
  return paths
    .filter(
      (path) => JSON.stringify(base.get(path) ?? null) !== JSON.stringify(head.get(path) ?? null),
    )
    .map((path) => {
      const before = base.get(path);
      const after = head.get(path);
      return {
        path,
        before: before ?? null,
        after: after ?? null,
        line: [
          path,
          before?.mode ?? "-",
          before?.type ?? "-",
          before?.sha ?? "-",
          after?.mode ?? "-",
          after?.type ?? "-",
          after?.sha ?? "-",
        ].join("\t"),
      };
    });
}

async function listPullRequestFiles(api, number) {
  const out = [];
  const filenames = new Set();
  for (let page = 1; page <= maxFilePages; page += 1) {
    const value = await api(
      `/repos/${CONTRACT.repository}/pulls/${number}/files?per_page=${filesPerPage}&page=${page}`,
    );
    invariant(Array.isArray(value), "pull-request file listing is invalid");
    for (const file of value) {
      invariant(
        typeof file?.filename === "string" && file.filename.length > 0,
        "pull-request file has an invalid path",
      );
      invariant(
        !filenames.has(file.filename),
        "pull-request file listing contains a duplicate path",
      );
      invariant(
        allowedFileStatuses.has(file.status),
        `pull-request file has an invalid status: ${file.filename}`,
      );
      filenames.add(file.filename);
      out.push(file);
    }
    if (value.length < filesPerPage) return out;
  }
  throw new Error(`pull-request file listing exceeded ${maxFilePages * filesPerPage} records`);
}

function assertFileProjection(files, manifest, expectedCount) {
  invariant(
    files.length === expectedCount,
    "pull-request changed-file count differs from its file listing",
  );
  const projectedPaths = new Set();
  for (const file of files) {
    invariant(!projectedPaths.has(file.filename), "pull-request file projection repeats a path");
    projectedPaths.add(file.filename);
    if (file.status === "renamed" || file.status === "copied") {
      invariant(
        typeof file.previous_filename === "string" && file.previous_filename.length > 0,
        `pull-request ${file.status} file lacks its previous path: ${file.filename}`,
      );
      invariant(
        !projectedPaths.has(file.previous_filename),
        "pull-request file projection repeats a previous path",
      );
      projectedPaths.add(file.previous_filename);
    }
  }
  const directPaths = manifest.map(({ path }) => path).sort(compareCodeUnits);
  const projected = [...projectedPaths].sort(compareCodeUnits);
  invariant(
    JSON.stringify(projected) === JSON.stringify(directPaths),
    "provider file projection differs from the direct tree delta",
  );
}

function assertComparison(value, baseSha, headSha) {
  invariant(value?.status === "ahead", "candidate head is not strictly ahead of current main");
  invariant(value?.base_commit?.sha === baseSha, "comparison base differs from current main");
  invariant(
    value?.merge_base_commit?.sha === baseSha,
    "current main is not the candidate head merge base",
  );
  invariant(
    Array.isArray(value?.commits) && value.commits.length > 0,
    "comparison commits are missing",
  );
  invariant(value.commits.at(-1)?.sha === headSha, "comparison head changed");
  invariant(value?.behind_by === 0, "candidate head is behind current main");
  invariant(
    Number.isSafeInteger(value?.ahead_by) && value.ahead_by > 0,
    "candidate head has no admitted commits",
  );
}

export async function verifySourceAdmission(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const context = expectedContext(env, options.event);
  const api = apiClient(options.fetchImpl ?? globalThis.fetch, context.token);
  const expectedRef = `refs/heads/${CONTRACT.defaultBranch}`;

  const [repository, initialMainRef, initialPull] = await Promise.all([
    api(`/repos/${CONTRACT.repository}`),
    api(`/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.defaultBranch}`),
    api(`/repos/${CONTRACT.repository}/pulls/${context.number}`),
  ]);
  assertRepository(repository);
  const baseSha = assertRef(initialMainRef, expectedRef, "default branch");
  invariant(
    baseSha === context.workflowSha,
    "current main differs from the base-owned workflow SHA",
  );
  invariant(context.eventBaseSha === baseSha, "event base SHA differs from current main");
  const headRef = assertString(context.event.pull_request.head.ref, "event head ref");
  assertPullRequest(initialPull, {
    number: context.number,
    baseSha,
    headRef,
    headRepository: context.headRepository,
    headSha: context.eventHeadSha,
  });

  const [baseCommit, headCommit, comparison, files] = await Promise.all([
    api(`/repos/${CONTRACT.repository}/git/commits/${baseSha}`),
    api(`/repos/${CONTRACT.repository}/git/commits/${context.eventHeadSha}`),
    api(`/repos/${CONTRACT.repository}/compare/${baseSha}...${context.eventHeadSha}`),
    listPullRequestFiles(api, context.number),
  ]);
  const baseTreeSha = assertCommit(baseCommit, baseSha, "current main commit");
  const headTreeSha = assertCommit(headCommit, context.eventHeadSha, "candidate head commit");
  assertComparison(comparison, baseSha, context.eventHeadSha);

  const [baseTree, headTree] = await Promise.all([
    api(`/repos/${CONTRACT.repository}/git/trees/${baseTreeSha}?recursive=1`),
    api(`/repos/${CONTRACT.repository}/git/trees/${headTreeSha}?recursive=1`),
  ]);
  const manifest = directTreeManifest(
    canonicalLeafMap(baseTree, baseTreeSha, "current main tree"),
    canonicalLeafMap(headTree, headTreeSha, "candidate head tree"),
  );
  invariant(manifest.length > 0, "candidate tree does not differ from current main");
  assertFileProjection(files, manifest, initialPull.changed_files);

  const [terminalMainRef, terminalPull] = await Promise.all([
    api(`/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.defaultBranch}`),
    api(`/repos/${CONTRACT.repository}/pulls/${context.number}`),
  ]);
  invariant(
    assertRef(terminalMainRef, expectedRef, "terminal default branch") === baseSha,
    "default branch drifted during admission",
  );
  assertPullRequest(terminalPull, {
    number: context.number,
    baseSha,
    headRef,
    headRepository: context.headRepository,
    headSha: context.eventHeadSha,
  });
  invariant(
    terminalPull.changed_files === initialPull.changed_files,
    "pull-request changed-file count drifted during admission",
  );

  const manifestText = `${manifest.map(({ line }) => line).join("\n")}\n`;
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  logger.log(
    `Source admission verified ${context.eventHeadSha} on current main ${baseSha}: ` +
      `${manifest.length} direct tree paths, manifest sha256 ${manifestSha256}.`,
  );
  return {
    baseSha,
    headSha: context.eventHeadSha,
    baseTreeSha,
    headTreeSha,
    manifest,
    manifestSha256,
  };
}

if (import.meta.main) {
  verifySourceAdmission().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
