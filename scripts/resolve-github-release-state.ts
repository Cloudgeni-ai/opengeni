type GitHubApiResponse = {
  status: number;
  body: unknown;
};

export type GitHubReleaseApi = {
  get(path: string): Promise<GitHubApiResponse>;
};

export type GitHubReleaseState = {
  releaseExists: boolean;
  tagSha: string | null;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const sourceShaPattern = /^[0-9a-f]{40}$/;

export async function resolveGitHubReleaseState(input: {
  repository: string;
  tag: string;
  api: GitHubReleaseApi;
}): Promise<GitHubReleaseState> {
  if (!repositoryPattern.test(input.repository)) {
    throw new Error("GitHub repository must be an exact owner/name pair");
  }
  if (!tagPattern.test(input.tag)) {
    throw new Error("GitHub release tag is invalid");
  }

  const release = await input.api.get(
    `/repos/${input.repository}/releases/tags/${encodeURIComponent(input.tag)}`,
  );
  let releaseExists: boolean;
  if (release.status === 200) {
    const value = record(release.body, "GitHub release");
    if (value.tag_name !== input.tag) {
      throw new Error("GitHub release response tag does not match the requested tag");
    }
    releaseExists = true;
  } else if (release.status === 404) {
    releaseExists = false;
  } else {
    throw new Error(`GitHub release lookup failed with HTTP ${release.status}`);
  }

  const commit = await input.api.get(
    `/repos/${input.repository}/commits/${encodeURIComponent(input.tag)}`,
  );
  let tagSha: string | null;
  if (commit.status === 200) {
    const value = record(commit.body, "GitHub tag commit");
    if (typeof value.sha !== "string" || !sourceShaPattern.test(value.sha)) {
      throw new Error("GitHub tag commit response has an invalid SHA");
    }
    tagSha = value.sha;
  } else if (commit.status === 404) {
    if (releaseExists) {
      throw new Error("GitHub release exists without a resolvable tag commit");
    }
    tagSha = null;
  } else {
    throw new Error(`GitHub tag commit lookup failed with HTTP ${commit.status}`);
  }

  return { releaseExists, tagSha };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function githubApi(token: string, baseUrl: string): GitHubReleaseApi {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async get(path: string): Promise<GitHubApiResponse> {
      const response = await fetch(`${base}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      let body: unknown = null;
      if (response.status !== 404) {
        try {
          body = await response.json();
        } catch {
          throw new Error(`GitHub API returned non-JSON HTTP ${response.status}`);
        }
      }
      return { status: response.status, body };
    },
  };
}

if (import.meta.main) {
  const [tag, ...extra] = process.argv.slice(2);
  if (!tag || extra.length > 0) {
    throw new Error("usage: bun scripts/resolve-github-release-state.ts <tag>");
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const state = await resolveGitHubReleaseState({
    repository,
    tag,
    api: githubApi(token, process.env.GITHUB_API_URL ?? "https://api.github.com"),
  });
  console.log(JSON.stringify(state));
}
