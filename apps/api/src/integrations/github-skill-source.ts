import type { Settings } from "@opengeni/config";
import type { GitHubSkillSourceClient, GitHubSkillTreeEntry } from "@opengeni/core";
import { pinnedFetch, readResponseJsonBounded, readResponseTextBounded } from "@opengeni/network";

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
  return {
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
        throw new Error(`${label} is temporarily unavailable because GitHub limited the request`);
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
