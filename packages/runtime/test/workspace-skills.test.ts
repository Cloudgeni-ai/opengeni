import { describe, expect, test } from "bun:test";

import { Manifest, type SandboxSessionLike } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing";

import { buildAgentCapabilities, repositoryWorkspaceSkillPathsOption } from "../src";
import { discoverWorkspaceSkills } from "../src/workspace-skills";

describe("workspace repository skills", () => {
  test("does not add workspace probes when no repository is attached", () => {
    expect(repositoryWorkspaceSkillPathsOption([])).toEqual({});
    expect(
      repositoryWorkspaceSkillPathsOption([
        {
          kind: "file",
          fileId: "6c9dc458-aa03-4543-b92f-cbcf483c4f2d",
          mountPath: "files/input",
        },
      ]),
    ).toEqual({});
  });

  test("checks both a connected-machine root and managed repository mounts", () => {
    expect(
      repositoryWorkspaceSkillPathsOption([
        {
          kind: "repository",
          uri: "https://example.com/example/project.git",
          ref: "main",
          mountPath: "repos/example/project",
        },
      ]),
    ).toEqual({
      workspaceSkillPaths: [
        { path: ".agents/skills", source: "workspace .agents/skills" },
        { path: ".claude/skills", source: "workspace .claude/skills" },
        {
          path: "repos/example/project/.agents/skills",
          source: "repos/example/project/.agents/skills",
        },
        {
          path: "repos/example/project/.claude/skills",
          source: "repos/example/project/.claude/skills",
        },
      ],
    });
  });

  test("discovers real workspace paths and deduplicates identical aliases", async () => {
    const skill = `---
name: release
description: Prepare a safe release.
---

# Release
`;
    const session = fakeSession({
      ".agents/skills/release/SKILL.md": skill,
      ".agents/skills/release/references/checklist.md": "verify\n",
      ".claude/skills/release/SKILL.md": skill,
      ".claude/skills/release/references/checklist.md": "verify\n",
    });
    const skills = await discoverWorkspaceSkills(session, [
      { path: ".agents/skills", source: ".agents/skills" },
      { path: ".claude/skills", source: ".claude/skills" },
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "release",
      description: "Prepare a safe release.",
      path: ".agents/skills/release/SKILL.md",
    });
  });

  test("fails when the same skill name has different contents", async () => {
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: First definition.\n---\n",
      ".claude/skills/release/SKILL.md":
        "---\nname: release\ndescription: Different definition.\n---\n",
    });
    await expect(
      discoverWorkspaceSkills(session, [
        { path: ".agents/skills", source: ".agents/skills" },
        { path: ".claude/skills", source: ".claude/skills" },
      ]),
    ).rejects.toThrow(
      'Workspace skill "release" has conflicting definitions in .agents/skills and .claude/skills',
    );
  });

  test("fails instead of ambiguously shadowing configured skills", async () => {
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Repository release instructions.\n---\n",
    });
    await expect(
      discoverWorkspaceSkills(
        session,
        [{ path: ".agents/skills", source: ".agents/skills" }],
        new Set(["release"]),
      ),
    ).rejects.toThrow('Workspace skill "release" conflicts with a configured OpenGeni skill');
  });

  test("deduplicates identical inline session skills and rejects conflicts", () => {
    const release = {
      name: "release",
      files: [{ path: "SKILL.md", content: "# Release\n" }],
    };
    expect(() =>
      buildAgentCapabilities(testSettings(), [], {
        sessionSkills: [release, { ...release, files: [...release.files] }],
      }),
    ).not.toThrow();
    expect(() =>
      buildAgentCapabilities(testSettings(), [], {
        sessionSkills: [
          release,
          { name: "release", files: [{ path: "SKILL.md", content: "# Different\n" }] },
        ],
      }),
    ).toThrow('Conflicting skill definitions for "release"');
  });
});

function fakeSession(files: Record<string, string>): SandboxSessionLike {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, content]) => [normalize(path), content]),
  );
  const directories = new Set<string>([""]);
  for (const path of normalizedFiles.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return {
    state: { manifest: new Manifest({ root: "/workspace" }) },
    listDir: async ({ path }) => {
      const directory = normalize(path);
      if (!directories.has(directory)) throw new Error("not found");
      const prefix = directory ? `${directory}/` : "";
      const names = new Map<string, "file" | "dir">();
      for (const candidate of directories) {
        if (!candidate.startsWith(prefix) || candidate === directory) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder.includes("/")) names.set(remainder, "dir");
      }
      for (const candidate of normalizedFiles.keys()) {
        if (!candidate.startsWith(prefix)) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder.includes("/")) names.set(remainder, "file");
      }
      return [...names].map(([name, type]) => ({
        name,
        type,
        path: prefix ? `${prefix}${name}` : name,
      }));
    },
    readFile: async ({ path }) => {
      const content = normalizedFiles.get(normalize(path));
      if (content === undefined) throw new Error("not found");
      return content;
    },
  };
}

function normalize(path: string): string {
  return path.replace(/^\/workspace\/?/, "").replace(/^\/+|\/+$/g, "");
}
