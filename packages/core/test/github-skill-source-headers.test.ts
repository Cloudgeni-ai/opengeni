import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

import {
  githubSkillSourceFailure,
  githubSkillSourceHeaders,
} from "../src/domain/github-skill-source";

describe("GitHub Skill source request headers", () => {
  test("reads unauthenticated when no token is configured", () => {
    const headers = githubSkillSourceHeaders(getSettings({} as NodeJS.ProcessEnv));
    expect(headers.authorization).toBeUndefined();
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["user-agent"]).toBe("OpenGeni-Capabilities");
  });

  test("authenticates Skill reads with the configured token", () => {
    const settings = getSettings({
      OPENGENI_SKILL_IMPORT_GITHUB_TOKEN: "ghp_example",
    } as NodeJS.ProcessEnv);
    expect(githubSkillSourceHeaders(settings).authorization).toBe("Bearer ghp_example");
  });
});

describe("GitHub Skill source failures", () => {
  const anonymous = getSettings({} as NodeJS.ProcessEnv);
  const withToken = getSettings({
    OPENGENI_SKILL_IMPORT_GITHUB_TOKEN: "github_pat_example",
  } as NodeJS.ProcessEnv);
  const failure = (
    settings: typeof anonymous,
    status: number,
    headers: Record<string, string> = {},
  ) =>
    githubSkillSourceFailure(
      settings,
      { status, headers: new Headers(headers) },
      "GitHub Skill tree",
    );
  const limit = (error: Error) => error instanceof HTTPException && error.status === 429;

  test("anonymous reads keep today's mapping", () => {
    expect(failure(anonymous, 404).message).toBe(
      "GitHub Skill tree was not found or is not public",
    );
    expect(limit(failure(anonymous, 403))).toBe(true);
    expect(failure(anonymous, 403).message).toContain("public request limit");
    expect(limit(failure(anonymous, 429))).toBe(true);
    expect(failure(anonymous, 401).message).toBe("GitHub Skill tree failed with HTTP 401");
  });

  test("with a token, a refused token is not reported as a rate limit", () => {
    for (const status of [401, 403]) {
      const error = failure(withToken, status);
      expect(limit(error)).toBe(false);
      expect(error.message).toContain("rejected this deployment's Skill import token");
      expect(error.message).not.toContain("github_pat_example");
    }
    for (const headers of [{ "x-ratelimit-remaining": "0" }, { "retry-after": "60" }]) {
      const error = failure(withToken, 403, headers);
      expect(limit(error)).toBe(true);
      expect(error.message).toContain("request limit for this deployment");
    }
    expect(limit(failure(withToken, 429))).toBe(true);
    expect(failure(withToken, 500).message).toBe("GitHub Skill tree failed with HTTP 500");
  });
});
