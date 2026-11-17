import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";

import { githubSkillSourceHeaders } from "../src/domain/github-skill-source";

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
