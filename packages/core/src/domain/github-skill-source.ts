import type { Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import type { GitHubSkillSourceClient, GitHubSkillTreeEntry } from "./skill-imports";
import { pinnedFetch, readResponseJsonBounded, readResponseTextBounded } from "@opengeni/network";
import {
  PORTABLE_SKILL_MAX_FILES,
  PORTABLE_SKILL_MAX_TOTAL_BYTES,
  type SkillLibraryFile,
} from "@opengeni/runtime/skill-library";

const githubApiBase = "https://api.github.com";
const githubRequestTimeoutMs = 15_000;
const githubMetadataMaxBytes = 4 * 1024 * 1024;
const githubBlobResponseMaxBytes = 512 * 1024;

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
        expires: Date.now() + (path.includes("/commits/") ? 60_000 : 3_600_000),
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
  return {
    downloadSnapshot: (owner, repository, slug) =>
      downloadSkillSnapshot(settings, owner, repository, slug),
    resolveCommit: async (owner, repository, ref) => {
      const payload = recordValue(
        await requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(ref)}`,
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
      const payload = recordValue(
        await requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
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
      const payload = recordValue(
        await requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs/${encodeURIComponent(sha)}`,
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
      const bytes = Uint8Array.from(Buffer.from(normalized, "base64"));
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
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "OpenGeni-Capabilities",
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
      },
      settings,
      { label, requireHttpsOutsideLocalTest: true },
    );
    if (!response.ok) {
      await readResponseTextBounded(response, 8_192, `${label} error`).catch(() => undefined);
      if (response.status === 404) throw new Error(`${label} was not found or is not public`);
      if (response.status === 403 || response.status === 429) {
        throw new HTTPException(429, {
          message:
            "GitHub's public request limit has been reached. Skill search is still available; try previewing again after the limit resets.",
        });
      }
      throw new Error(`${label} failed with HTTP ${response.status}`);
    }
    return await readResponseJsonBounded(response, maxBytes, label, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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
