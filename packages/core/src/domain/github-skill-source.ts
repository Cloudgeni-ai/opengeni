import type { Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import type { GitHubSkillSourceClient, GitHubSkillTreeEntry } from "./skill-imports";
import { pinnedFetch, readResponseJsonBounded, readResponseTextBounded } from "@opengeni/network";
import {
  PORTABLE_SKILL_MAX_FILES,
  PORTABLE_SKILL_MAX_FILE_BYTES,
  PORTABLE_SKILL_MAX_TOTAL_BYTES,
  type SkillLibraryFile,
} from "@opengeni/runtime/skill-library";

const githubApiBase = "https://api.github.com";
const githubRequestTimeoutMs = 15_000;
const githubMetadataMaxBytes = 4 * 1024 * 1024;
// GitHub blobs are base64-encoded JSON; allow framing and line wrapping.
const githubBlobResponseMaxBytes = PORTABLE_SKILL_MAX_FILE_BYTES * 2;
// Commits move and a repository can be made private, so these stay fresh.
const shortLivedGitHubPath = /^\/repos\/[^/]+\/[^/]+(?:\/commits\/.*)?$/u;

type GitHubJsonRequest = (path: string, maxBytes: number, label: string) => Promise<unknown>;

export function createGitHubSkillSourceClient(
  settings: Settings,
  requestJson: GitHubJsonRequest = (path, maxBytes, label) =>
    githubJson(settings, path, maxBytes, label),
): GitHubSkillSourceClient {
  const readJson = requestJson;
  const cache = new Map<string, { expires: number; payload: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  requestJson = async (path, maxBytes, label) => {
    const cached = cache.get(path);
    if (cached && cached.expires > Date.now()) return cached.payload;
    const existing = pending.get(path);
    if (existing) return existing;
    const task = readJson(path, maxBytes, label).then((payload) => {
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(path, {
        payload,
        expires: Date.now() + (shortLivedGitHubPath.test(path) ? 60_000 : 3_600_000),
      });
      return payload;
    });
    pending.set(path, task);
    try {
      return await task;
    } finally {
      pending.delete(path);
    }
  };
  const repositoryPath = (owner: string, repository: string) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  // A configured token reads whatever its account can see. Imports are public
  // only, so with a token every read first confirms the repository is public
  // (anonymous reads can't see anything else). Private and internal
  // repositories answer exactly like a missing one.
  const requirePublicRepository = async (owner: string, repository: string) => {
    if (!settings.skillImportGithubToken) return;
    const payload = recordValue(
      await requestJson(
        repositoryPath(owner, repository),
        githubMetadataMaxBytes,
        "GitHub Skill repository",
      ),
      "GitHub repository",
    );
    if (
      payload.private !== false ||
      (payload.visibility !== undefined && payload.visibility !== "public")
    ) {
      throw new Error("GitHub Skill repository was not found or is not public");
    }
  };
  return {
    downloadSnapshot: (owner, repository, slug) =>
      downloadSkillSnapshot(settings, owner, repository, slug),
    resolveCommit: async (owner, repository, ref) => {
      await requirePublicRepository(owner, repository);
      const payload = recordValue(
        await requestJson(
          `${repositoryPath(owner, repository)}/commits/${encodeURIComponent(ref)}`,
          githubMetadataMaxBytes,
          "GitHub Skill commit",
        ),
        "GitHub commit",
      );
      const sha = stringValue(payload.sha);
      if (!sha) throw new Error("GitHub commit response omitted sha");
      return sha.toLowerCase();
    },
    listTree: async (owner, repository, commit) => {
      await requirePublicRepository(owner, repository);
      const payload = recordValue(
        await requestJson(
          `${repositoryPath(owner, repository)}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
          githubMetadataMaxBytes,
          "GitHub Skill tree",
        ),
        "GitHub tree",
      );
      if (payload.truncated === true) {
        throw new Error("GitHub repository tree is too large to import safely");
      }
      if (!Array.isArray(payload.tree)) throw new Error("GitHub tree response omitted entries");
      return payload.tree.map((entry, index): GitHubSkillTreeEntry => {
        const record = recordValue(entry, `GitHub tree entry ${index}`);
        const path = stringValue(record.path);
        const type = stringValue(record.type);
        const mode = stringValue(record.mode);
        const sha = stringValue(record.sha);
        const size = record.size;
        if (
          !path ||
          (type !== "blob" && type !== "tree" && type !== "commit") ||
          !mode ||
          !sha ||
          (size !== undefined &&
            size !== null &&
            (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0))
        ) {
          throw new Error(`GitHub tree entry ${index} is invalid`);
        }
        return { path, type, mode, sha, size: typeof size === "number" ? size : null };
      });
    },
    readBlob: async (owner, repository, sha) => {
      await requirePublicRepository(owner, repository);
      const payload = recordValue(
        await requestJson(
          `${repositoryPath(owner, repository)}/git/blobs/${encodeURIComponent(sha)}`,
          githubBlobResponseMaxBytes,
          "GitHub Skill file",
        ),
        "GitHub blob",
      );
      if (payload.encoding !== "base64" || typeof payload.content !== "string") {
        throw new Error("GitHub Skill file did not use base64 encoding");
      }
      const normalized = payload.content.replace(/\s+/gu, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) {
        throw new Error("GitHub Skill file contained invalid base64");
      }
      const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
      if (
        typeof payload.size === "number" &&
        Number.isSafeInteger(payload.size) &&
        payload.size !== bytes.byteLength
      ) {
        throw new Error("GitHub Skill file size did not match its payload");
      }
      return bytes;
    },
  };
}

async function downloadSkillSnapshot(
  settings: Settings,
  owner: string,
  repository: string,
  slug: string,
): Promise<readonly SkillLibraryFile[]> {
  const signal = AbortSignal.timeout(githubRequestTimeoutMs);
  const response = await pinnedFetch(
    `https://skills.sh/api/download/${[owner, repository, slug].map(encodeURIComponent).join("/")}`,
    { headers: { accept: "application/json" }, credentials: "omit", redirect: "manual", signal },
    settings,
    { label: "Skill download", requireHttpsOutsideLocalTest: true },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new HTTPException(response.status === 429 ? 429 : 422, {
      message:
        response.status === 429
          ? "skills.sh is busy. Try again shortly."
          : response.status === 404
            ? "This skill has no downloadable snapshot. Import its GitHub folder URL instead."
            : "Could not download this skill from skills.sh. Try again shortly.",
    });
  }
  // JSON escaping may expand the text payload. Artifact validation below applies
  // the stricter limits to decoded files, paths, and total content size.
  const payload = recordValue(
    await readResponseJsonBounded(
      response,
      PORTABLE_SKILL_MAX_TOTAL_BYTES * 6 + 128_000,
      "Skill download",
      { signal },
    ),
    "Skill download",
  );
  if (
    !Array.isArray(payload.files) ||
    payload.files.length === 0 ||
    payload.files.length > PORTABLE_SKILL_MAX_FILES
  ) {
    throw new HTTPException(422, { message: "The downloaded skill has an invalid file list" });
  }
  return payload.files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      typeof file.contents !== "string"
    ) {
      throw new HTTPException(422, { message: "The downloaded skill contains an invalid file" });
    }
    return { path: file.path, content: file.contents };
  });
}

/**
 * Headers for GitHub REST reads behind Skill preview and install. A configured
 * token lifts the shared per-IP budget unauthenticated callers get (60/hour for
 * the whole deployment) to the token's own 5,000/hour. They are only ever sent
 * to the fixed `api.github.com` origin, and `pinnedFetch` never follows a
 * redirect, so the token can't reach another host.
 */
export function githubSkillSourceHeaders(settings: Settings): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "OpenGeni-Capabilities",
    "x-github-api-version": "2022-11-28",
  };
  if (settings.skillImportGithubToken) {
    headers.authorization = `Bearer ${settings.skillImportGithubToken}`;
  }
  return headers;
}

async function githubJson(
  settings: Settings,
  path: string,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), githubRequestTimeoutMs);
  try {
    const response = await pinnedFetch(
      `${githubApiBase}${path}`,
      {
        method: "GET",
        headers: githubSkillSourceHeaders(settings),
        signal: controller.signal,
      },
      settings,
      { label, requireHttpsOutsideLocalTest: true },
    );
    if (!response.ok) {
      await readResponseTextBounded(response, 8_192, `${label} error`).catch(() => undefined);
      throw githubSkillSourceFailure(settings, response, label);
    }
    return await readResponseJsonBounded(response, maxBytes, label, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The error for a failed GitHub read. Anonymous 403s are the shared rate limit.
 * With a token, a 403 is a limit only when GitHub says so (no requests left or
 * a Retry-After); otherwise GitHub refused the token itself, for example an
 * organization's SSO or fine-grained token policy, as with a 401.
 */
export function githubSkillSourceFailure(
  settings: Settings,
  response: Pick<Response, "status" | "headers">,
  label: string,
): Error {
  const { status, headers } = response;
  const token = Boolean(settings.skillImportGithubToken);
  if (status === 404) return new Error(`${label} was not found or is not public`);
  const limited =
    status === 429 ||
    (status === 403 &&
      (!token ||
        headers.get("x-ratelimit-remaining") === "0" ||
        headers.get("retry-after") !== null));
  if (limited) {
    return new HTTPException(429, {
      message: token
        ? "GitHub's request limit for this deployment has been reached. Skill search is still available; try previewing again after the limit resets."
        : "GitHub's public request limit has been reached. Skill search is still available; try previewing again after the limit resets.",
    });
  }
  if (token && (status === 401 || status === 403)) {
    return new Error(
      "GitHub rejected this deployment's Skill import token. Ask its administrator to check OPENGENI_SKILL_IMPORT_GITHUB_TOKEN.",
    );
  }
  return new Error(`${label} failed with HTTP ${status}`);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response is invalid`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
