import { describe, expect, test } from "bun:test";

import {
  parseSkillSource,
  resolveSkillImport,
  type GitHubSkillSourceClient,
  type GitHubSkillTreeEntry,
} from "../src";

const commit = "a".repeat(40);
const skillMarkdown = `---
name: release-operator
description: Prepare, verify, and publish a safe release.
---
# Release operator
`;

function sourceClient(
  tree: readonly GitHubSkillTreeEntry[],
  contents: Record<string, string>,
): GitHubSkillSourceClient {
  return {
    resolveCommit: async () => commit,
    listTree: async () => tree,
    readBlob: async (_owner, _repository, sha) => {
      const content = contents[sha];
      if (content === undefined) throw new Error(`missing blob ${sha}`);
      return new TextEncoder().encode(content);
    },
  };
}

describe("remote Skill source resolution", () => {
  test("parses skills.sh and exact GitHub folder URLs without accepting other hosts", () => {
    expect(parseSkillSource("https://skills.sh/acme/agent-skills/release-operator")).toMatchObject({
      source: "skills_sh",
      owner: "acme",
      repository: "agent-skills",
      skillSlug: "release-operator",
    });
    expect(
      parseSkillSource(
        "https://github.com/acme/agent-skills/tree/main/operations/release-operator",
      ),
    ).toMatchObject({
      source: "github",
      ref: "main",
      requestedPath: "operations/release-operator",
    });
    expect(() => parseSkillSource("https://example.com/acme/skills/release")).toThrow(
      "Only github.com and skills.sh",
    );
    expect(() => parseSkillSource("https://user:secret@github.com/acme/skills")).toThrow(
      "credential-free HTTPS",
    );
  });

  test("resolves skills.sh to one exact immutable GitHub folder and previews every file", async () => {
    const resolved = await resolveSkillImport(
      "https://skills.sh/acme/agent-skills/release-operator",
      sourceClient(
        [
          {
            path: "operations/release-operator/SKILL.md",
            type: "blob",
            mode: "100644",
            sha: "skill",
            size: skillMarkdown.length,
          },
          {
            path: "operations/release-operator/references/checklist.md",
            type: "blob",
            mode: "100644",
            sha: "checklist",
            size: 8,
          },
          {
            path: "other/SKILL.md",
            type: "blob",
            mode: "100644",
            sha: "other",
            size: skillMarkdown.length,
          },
        ],
        { skill: skillMarkdown, checklist: "Verify.\n", other: skillMarkdown },
      ),
    );
    expect(resolved.preview).toMatchObject({
      source: "skills_sh",
      sourceCommit: commit,
      sourcePath: "operations/release-operator",
      name: "release-operator",
      description: "Prepare, verify, and publish a safe release.",
      files: [{ path: "SKILL.md" }, { path: "references/checklist.md" }],
    });
    expect(resolved.preview.sourceUrl).toBe(
      `https://github.com/acme/agent-skills/tree/${commit}/operations/release-operator`,
    );
    expect(resolved.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
  });

  test("fails closed on ambiguous repositories, symlinks, and submodules", async () => {
    const ambiguous = sourceClient(
      ["one", "two"].map((root) => ({
        path: `${root}/SKILL.md`,
        type: "blob" as const,
        mode: "100644",
        sha: root,
        size: skillMarkdown.length,
      })),
      { one: skillMarkdown, two: skillMarkdown },
    );
    await expect(resolveSkillImport("https://github.com/acme/skills", ambiguous)).rejects.toThrow(
      "multiple Skills",
    );

    const unsafe = sourceClient(
      [
        {
          path: "release/SKILL.md",
          type: "blob",
          mode: "100644",
          sha: "skill",
          size: skillMarkdown.length,
        },
        {
          path: "release/scripts/current",
          type: "blob",
          mode: "120000",
          sha: "link",
          size: 10,
        },
      ],
      { skill: skillMarkdown, link: "../outside" },
    );
    await expect(
      resolveSkillImport("https://github.com/acme/skills/tree/main/release", unsafe),
    ).rejects.toThrow("symbolic links or submodules");
  });
});
