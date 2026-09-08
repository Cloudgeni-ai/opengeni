import { describe, expect, test } from "bun:test";

import {
  parseSkillSource,
  resolveSkillImport,
  type GitHubSkillSourceClient,
  type GitHubSkillTreeEntry,
} from "../src/domain/skill-imports";

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
        {
          skill: skillMarkdown,
          checklist: "Verify.\n",
          other: skillMarkdown.replace("release-operator", "other"),
        },
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

  test("matches frontmatter identity rather than directory and reuses pinned metadata blobs", async () => {
    const reads: string[] = [];
    const resolved = await resolveSkillImport(
      "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices",
      {
        resolveCommit: async (_owner, _repo, ref) => {
          expect(ref).toBe("HEAD");
          return commit;
        },
        listTree: async (_owner, _repo, revision) => {
          expect(revision).toBe(commit);
          return [
            {
              path: "skills/react-best-practices/SKILL.md",
              type: "blob",
              mode: "100644",
              sha: "metadata",
              size: null,
            },
          ];
        },
        readBlob: async (_owner, _repo, sha) => {
          reads.push(sha);
          return new TextEncoder().encode(
            skillMarkdown.replace("release-operator", "vercel-react-best-practices"),
          );
        },
      },
    );
    expect(resolved.preview.sourcePath).toBe("skills/react-best-practices");
    expect(resolved.preview.sourceCommit).toBe(commit);
    expect(reads).toEqual(["metadata"]);
  });

  test("duplicate frontmatter identities require an exact folder override", async () => {
    const client = sourceClient(
      ["one", "release-operator"].map((path) => ({
        path: `${path}/SKILL.md`,
        type: "blob",
        mode: "100644",
        sha: path,
        size: null,
      })),
      { one: skillMarkdown, "release-operator": skillMarkdown },
    );
    await expect(
      resolveSkillImport("https://skills.sh/acme/skills/release-operator", client),
    ).rejects.toThrow("multiple Skills");
    const resolved = await resolveSkillImport(
      `https://github.com/acme/skills/tree/${commit}/one`,
      client,
    );
    expect(resolved.preview.sourcePath).toBe("one");
  });

  test("rejects a stale slug even when its folder basename exists; exact folders still work", async () => {
    const client = sourceClient(
      [{ path: "alias/SKILL.md", type: "blob", mode: "100644", sha: "skill", size: null }],
      { skill: skillMarkdown },
    );
    await expect(resolveSkillImport("https://skills.sh/acme/skills/alias", client)).rejects.toThrow(
      'No Skill frontmatter name matches skills.sh slug "alias"',
    );
    await expect(resolveSkillImport("https://skills.sh/acme/skills/alias", client)).rejects.toThrow(
      `https://github.com/acme/skills/tree/${commit}/alias`,
    );
    await expect(
      resolveSkillImport("https://skills.sh/acme/skills/deleted-name", client),
    ).rejects.toThrow(`https://github.com/acme/skills/tree/${commit}/<exact-skill-folder-path>`);
    const exact = await resolveSkillImport(
      `https://github.com/acme/skills/tree/${commit}/alias`,
      client,
    );
    expect(exact.preview.name).toBe("release-operator");
    expect(exact.preview.sourcePath).toBe("alias");
    expect(
      (await resolveSkillImport("https://skills.sh/acme/skills/RELEASE-OPERATOR", client)).preview
        .contentSha256,
    ).toBe(exact.preview.contentSha256);
  });

  test("root Skill source URLs round trip through preview and exact commit URLs", async () => {
    const client = sourceClient(
      [{ path: "SKILL.md", type: "blob", mode: "100644", sha: "skill", size: null }],
      { skill: skillMarkdown },
    );
    const resolved = await resolveSkillImport("https://github.com/acme/skills", client);
    expect(resolved.preview.sourcePath).toBe(".");
    expect(
      (await resolveSkillImport(resolved.preview.sourceUrl, client)).preview.contentSha256,
    ).toBe(resolved.preview.contentSha256);
    expect(
      (await resolveSkillImport(`https://github.com/acme/skills/blob/${commit}/SKILL.md`, client))
        .preview.sourcePath,
    ).toBe(".");
  });

  test("bounds candidate scanning before reading blobs", async () => {
    let reads = 0;
    const client = sourceClient(
      Array.from({ length: 129 }, (_, index) => ({
        path: `skill-${index}/SKILL.md`,
        type: "blob",
        mode: "100644",
        sha: String(index),
        size: null,
      })),
      {},
    );
    await expect(
      resolveSkillImport("https://skills.sh/acme/skills/release-operator", {
        ...client,
        readBlob: async () => {
          reads++;
          return new Uint8Array();
        },
      }),
    ).rejects.toThrow("Too many Skill candidates");
    expect(reads).toBe(0);
  });

  test("bounds actual metadata bytes when provider size is unknown", async () => {
    const client = sourceClient(
      [{ path: "one/SKILL.md", type: "blob", mode: "100644", sha: "skill", size: null }],
      {},
    );
    await expect(
      resolveSkillImport("https://skills.sh/acme/skills/release-operator", {
        ...client,
        readBlob: async () => new Uint8Array(256 * 1024 + 1),
      }),
    ).rejects.toThrow("metadata is too large");
  });

  test("preserves leading UTF-8 BOM bytes in metadata and supporting files", async () => {
    const contents = {
      skill: `\uFEFF${skillMarkdown}`,
      reference: "\uFEFFKeep these exact bytes.\n",
    };
    const client = sourceClient(
      [
        { path: "folder/SKILL.md", type: "blob", mode: "100644", sha: "skill", size: null },
        {
          path: "folder/references/note.md",
          type: "blob",
          mode: "100644",
          sha: "reference",
          size: null,
        },
      ],
      contents,
    );
    const resolved = await resolveSkillImport(
      "https://skills.sh/acme/skills/release-operator",
      client,
    );
    expect(resolved.files.find((file) => file.path === "SKILL.md")?.content).toBe(contents.skill);
    expect(resolved.files.find((file) => file.path === "references/note.md")?.content).toBe(
      contents.reference,
    );
    expect(resolved.preview.totalBytes).toBe(
      new TextEncoder().encode(contents.skill).byteLength +
        new TextEncoder().encode(contents.reference).byteLength,
    );
  });

  test("preserves network failures instead of mislabelling them invalid UTF-8", async () => {
    const client = sourceClient(
      [{ path: "one/SKILL.md", type: "blob", mode: "100644", sha: "skill", size: null }],
      {},
    );
    await expect(
      resolveSkillImport("https://github.com/acme/skills/tree/main/one", {
        ...client,
        readBlob: async () => {
          throw new Error("GitHub limited the request");
        },
      }),
    ).rejects.toThrow("GitHub limited the request");
    expect(() => parseSkillSource("https://github.com/acme/skills/tree/main/%zz")).toThrow(
      "invalid encoding",
    );
  });

  test("stops scheduling candidate reads once aggregate metadata exceeds its budget", async () => {
    let reads = 0;
    const client = sourceClient(
      Array.from({ length: 24 }, (_, index) => ({
        path: `skill-${index}/SKILL.md`,
        type: "blob",
        mode: "100644",
        sha: String(index),
        size: null,
      })),
      {},
    );
    const metadata = new TextEncoder().encode(`${skillMarkdown}${" ".repeat(200 * 1024)}`);
    await expect(
      resolveSkillImport("https://skills.sh/acme/skills/release-operator", {
        ...client,
        readBlob: async () => {
          reads++;
          return metadata;
        },
      }),
    ).rejects.toThrow("metadata is too large");
    // Eight reads can already be in flight when one detects the limit.
    expect(reads).toBeLessThanOrEqual(13);
  });
});
