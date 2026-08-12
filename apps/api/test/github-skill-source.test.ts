import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";

import { createGitHubSkillSourceClient } from "../src/integrations/github-skill-source";

describe("GitHub Skill source transport", () => {
  test("uses exact GitHub APIs and validates commit, tree, and blob payloads", async () => {
    const requests: Array<{ path: string; maxBytes: number; label: string }> = [];
    const client = createGitHubSkillSourceClient(testSettings(), async (path, maxBytes, label) => {
      requests.push({ path, maxBytes, label });
      if (path.includes("/commits/")) return { sha: "A".repeat(40) };
      if (path.includes("/git/trees/")) {
        return {
          truncated: false,
          tree: [
            {
              path: "release/SKILL.md",
              type: "blob",
              mode: "100644",
              sha: "b".repeat(40),
              size: 5,
            },
          ],
        };
      }
      return { encoding: "base64", content: Buffer.from("hello").toString("base64"), size: 5 };
    });

    expect(await client.resolveCommit("acme corp", "skills/tools", "feature/x")).toBe(
      "a".repeat(40),
    );
    expect(await client.listTree("acme", "skills", "a".repeat(40))).toEqual([
      {
        path: "release/SKILL.md",
        type: "blob",
        mode: "100644",
        sha: "b".repeat(40),
        size: 5,
      },
    ]);
    expect(new TextDecoder().decode(await client.readBlob("acme", "skills", "b".repeat(40)))).toBe(
      "hello",
    );
    expect(requests[0]!.path).toBe("/repos/acme%20corp/skills%2Ftools/commits/feature%2Fx");
    expect(requests.map((request) => request.label)).toEqual([
      "GitHub Skill commit",
      "GitHub Skill tree",
      "GitHub Skill file",
    ]);
  });

  test("fails closed on truncated trees and malformed or size-mismatched blobs", async () => {
    const truncated = createGitHubSkillSourceClient(testSettings(), async () => ({
      truncated: true,
      tree: [],
    }));
    await expect(truncated.listTree("acme", "skills", "a".repeat(40))).rejects.toThrow("too large");

    const malformed = createGitHubSkillSourceClient(testSettings(), async () => ({
      encoding: "base64",
      content: "not base64!",
      size: 1,
    }));
    await expect(malformed.readBlob("acme", "skills", "b".repeat(40))).rejects.toThrow(
      "invalid base64",
    );

    const mismatched = createGitHubSkillSourceClient(testSettings(), async () => ({
      encoding: "base64",
      content: Buffer.from("hello").toString("base64"),
      size: 6,
    }));
    await expect(mismatched.readBlob("acme", "skills", "b".repeat(40))).rejects.toThrow(
      "size did not match",
    );
  });
});
