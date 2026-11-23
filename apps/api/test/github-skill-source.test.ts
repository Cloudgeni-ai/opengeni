import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";

import { createGitHubSkillSourceClient } from "@opengeni/core";

describe("GitHub Skill source transport", () => {
  test("allows base64 transport for a maximum-size Skill file", async () => {
    const content = "x".repeat(2 * 1024 * 1024);
    const payload = {
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      size: content.length,
    };
    const client = createGitHubSkillSourceClient(testSettings(), async (_path, maxBytes) => {
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(maxBytes);
      return payload;
    });
    expect((await client.readBlob("acme", "skills", "b".repeat(40))).length).toBe(content.length);
  });
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

  test("without a token, reads skip the repository visibility check", async () => {
    const paths: string[] = [];
    const client = createGitHubSkillSourceClient(testSettings(), async (path) => {
      paths.push(path);
      return { sha: "a".repeat(40) };
    });
    await client.resolveCommit("acme", "skills", "main");
    expect(paths).toEqual(["/repos/acme/skills/commits/main"]);
  });

  test("with a token, reads only public repositories", async () => {
    const settings = testSettings({ skillImportGithubToken: "github_pat_test" });
    const repository = (record: Record<string, unknown>) => {
      const paths: string[] = [];
      const client = createGitHubSkillSourceClient(settings, async (path) => {
        paths.push(path);
        if (path === "/repos/acme/skills") return record;
        if (path.includes("/commits/")) return { sha: "a".repeat(40) };
        if (path.includes("/git/trees/")) return { truncated: false, tree: [] };
        return { encoding: "base64", content: Buffer.from("hi").toString("base64"), size: 2 };
      });
      return { client, paths };
    };

    const open = repository({ private: false, visibility: "public" });
    expect(await open.client.resolveCommit("acme", "skills", "main")).toBe("a".repeat(40));
    await open.client.listTree("acme", "skills", "a".repeat(40));
    await open.client.readBlob("acme", "skills", "b".repeat(40));
    // The visibility read comes first and is cached for the later reads.
    expect(open.paths).toEqual([
      "/repos/acme/skills",
      "/repos/acme/skills/commits/main",
      `/repos/acme/skills/git/trees/${"a".repeat(40)}?recursive=1`,
      `/repos/acme/skills/git/blobs/${"b".repeat(40)}`,
    ]);

    for (const record of [
      { private: true, visibility: "private" },
      { private: true, visibility: "internal" },
      { private: false, visibility: "internal" },
      { visibility: "public" },
    ]) {
      const hidden = repository(record);
      await expect(hidden.client.resolveCommit("acme", "skills", "main")).rejects.toThrow(
        "not found or is not public",
      );
      await expect(hidden.client.listTree("acme", "skills", "a".repeat(40))).rejects.toThrow(
        "not found or is not public",
      );
      await expect(hidden.client.readBlob("acme", "skills", "b".repeat(40))).rejects.toThrow(
        "not found or is not public",
      );
      expect(hidden.paths.every((path) => path === "/repos/acme/skills")).toBe(true);
    }
  });
});
