import type { Settings } from "@opengeni/config";
import { pinnedFetch, readResponseJsonBounded } from "@opengeni/network";

export type PublicSkillSearchInput = Readonly<{
  query: string;
  limit?: number;
  owner?: string;
}>;

export type PublicSkillSearchResult = Readonly<{
  provider: "skills_sh";
  query: string;
  items: readonly Readonly<{
    id: string;
    name: string;
    source: string;
    skillId: string;
    url: string;
    installs: number;
  }>[];
  nextCursor: null;
}>;

export type PublicSkillSearchClient = Readonly<{
  search(input: PublicSkillSearchInput): Promise<PublicSkillSearchResult>;
}>;

export type PublicSkillSearchErrorCode =
  | "invalid_query"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_response";

export class PublicSkillSearchError extends Error {
  constructor(
    readonly code: PublicSkillSearchErrorCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "PublicSkillSearchError";
  }
}

// Undocumented, unauthenticated compatibility endpoint used by the official CLI.
// Verified 2026-09-08 against vercel-labs/skills commit
// 1682051d48c34f5eb135e6475c1a965dce05e820, src/find.ts. This is NOT the documented
// /api/v1/skills/search API (which requires Vercel OIDC). Keep this contract behind
// this adapter: no promised pagination/quota, no CLI dependency or credentials.
const endpoint = "https://skills.sh/api/search";
const timeoutMs = 10_000;
const maxResponseBytes = 256 * 1024;
const maxResults = 20;
const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/iu;
const segmentPattern = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/iu;

export function createPublicSkillSearchClient(
  settings: Settings,
  fetcher: typeof pinnedFetch = pinnedFetch,
): PublicSkillSearchClient {
  return {
    async search(input) {
      const query = input.query.trim();
      const limit = input.limit ?? maxResults;
      const owner = input.owner?.trim().toLowerCase();
      if (
        query.length < 2 ||
        query.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(query) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > maxResults ||
        (owner !== undefined && !ownerPattern.test(owner))
      ) {
        throw new PublicSkillSearchError("invalid_query", "Invalid public Skill search parameters");
      }
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(limit));
      if (owner) url.searchParams.set("owner", owner);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PublicSkillSearchError("timeout", "Public Skill search timed out"));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          deadline,
          (async () => {
            const response = await fetcher(
              url,
              {
                method: "GET",
                headers: { accept: "application/json" },
                credentials: "omit",
                redirect: "manual",
                signal: controller.signal,
              },
              settings,
              { label: "Public Skill search", requireHttpsOutsideLocalTest: true },
            );
            if (controller.signal.aborted || !response.ok) {
              void response.body?.cancel().catch(() => undefined);
              if (controller.signal.aborted) {
                throw new PublicSkillSearchError("timeout", "Public Skill search timed out");
              }
              if (response.status === 429) {
                throw new PublicSkillSearchError(
                  "rate_limited",
                  "Public Skill search is rate limited",
                  parseRetryAfter(response.headers.get("retry-after")),
                );
              }
              throw new PublicSkillSearchError("unavailable", "Public Skill search is unavailable");
            }
            let payload: unknown;
            try {
              payload = await readResponseJsonBounded(
                response,
                maxResponseBytes,
                "Public Skill search",
                {
                  signal: controller.signal,
                },
              );
            } catch {
              throw new PublicSkillSearchError(
                controller.signal.aborted ? "timeout" : "invalid_response",
                controller.signal.aborted
                  ? "Public Skill search timed out"
                  : "Public Skill search returned an invalid response",
              );
            }
            return normalizeResponse(payload, query, limit, owner);
          })(),
        ]);
      } catch (error) {
        if (error instanceof PublicSkillSearchError) throw error;
        throw new PublicSkillSearchError(
          controller.signal.aborted ? "timeout" : "unavailable",
          controller.signal.aborted
            ? "Public Skill search timed out"
            : "Public Skill search is unavailable",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function normalizeResponse(
  payload: unknown,
  query: string,
  limit: number,
  owner: string | undefined,
): PublicSkillSearchResult {
  const invalid = () =>
    new PublicSkillSearchError(
      "invalid_response",
      "Public Skill search returned an invalid response",
    );
  if (!isRecord(payload) || !Array.isArray(payload.skills) || payload.skills.length > maxResults) {
    throw invalid();
  }
  const seen = new Set<string>();
  const items: PublicSkillSearchResult["items"][number][] = [];
  for (const skill of payload.skills) {
    if (!isRecord(skill) || typeof skill.id !== "string" || typeof skill.source !== "string")
      throw invalid();
    const parts = skill.id.split("/");
    if (
      parts.length !== 3 ||
      !ownerPattern.test(parts[0]!) ||
      !parts.every((part) => segmentPattern.test(part)) ||
      skill.source !== parts.slice(0, 2).join("/") ||
      (skill.skillId !== undefined && skill.skillId !== parts[2]) ||
      typeof skill.name !== "string" ||
      !skill.name.trim() ||
      skill.name.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(skill.name) ||
      typeof skill.installs !== "number" ||
      !Number.isSafeInteger(skill.installs) ||
      skill.installs < 0 ||
      (owner !== undefined && parts[0]!.toLowerCase() !== owner)
    )
      throw invalid();
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    items.push({
      id: skill.id,
      name: skill.name.trim(),
      source: skill.source,
      skillId: parts[2]!,
      url: `https://skills.sh/${parts.map(encodeURIComponent).join("/")}`,
      installs: skill.installs,
    });
  }
  return { provider: "skills_sh", query, items: items.slice(0, limit), nextCursor: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}
