import { describe, expect, test } from "bun:test";

import { Manifest, type SandboxSessionLike } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing";

import { buildAgentCapabilities, repositoryWorkspaceSkillPathsOption } from "../src";
import {
  type ModelPreparationMeasurement,
  withModelPreparationObserver,
} from "../src/model-preparation-diagnostics";
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

  test("records repository skill discovery duration and search-root count", async () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Prepare a safe release.\n---\n",
    });

    await withModelPreparationObserver(
      (measurement) => measurements.push(measurement),
      () =>
        discoverWorkspaceSkills(session, [
          { path: ".agents/skills", source: ".agents/skills" },
          { path: ".claude/skills", source: ".claude/skills" },
        ]),
    );

    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      phase: "repository_skill_discovery",
      outcome: "completed",
      count: 2,
    });
    expect(measurements[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  test("records failed repository skill discovery", async () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const session = {
      state: { manifest: new Manifest({ root: "/workspace" }) },
    } as SandboxSessionLike;

    await expect(
      withModelPreparationObserver(
        (measurement) => measurements.push(measurement),
        () =>
          discoverWorkspaceSkills(session, [{ path: ".agents/skills", source: ".agents/skills" }]),
      ),
    ).rejects.toThrow(
      "Workspace skill discovery requires sandbox listDir() and readFile() support",
    );
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      phase: "repository_skill_discovery",
      outcome: "failed",
      count: 1,
    });
  });

  test("unique skill names do not hash helper files", async () => {
    const skill = `---
name: release
description: Prepare a safe release.
---
`;
    const session = fakeSession({
      ".agents/skills/release/SKILL.md": skill,
      ".agents/skills/release/references/checklist.md": "verify\n",
      ".agents/skills/deploy/SKILL.md":
        "---\nname: deploy\ndescription: Deploy the service.\n---\n",
      ".agents/skills/deploy/scripts/run.sh": "echo deploy\n",
    });
    const reads: string[] = [];
    const listed: string[] = [];
    const originalRead = session.readFile!;
    const originalList = session.listDir!;
    session.readFile = async (args) => {
      reads.push(normalize(args.path));
      return await originalRead(args);
    };
    session.listDir = async (args) => {
      listed.push(normalize(args.path));
      return await originalList(args);
    };
    const skills = await discoverWorkspaceSkills(session, [
      { path: ".agents/skills", source: ".agents/skills" },
    ]);
    expect(skills.map((entry) => entry.name)).toEqual(["deploy", "release"]);
    expect(listed).toEqual([".agents/skills"]);
    expect(reads).toEqual([".agents/skills/deploy/SKILL.md", ".agents/skills/release/SKILL.md"]);
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

  test("same name with identical SKILL.md but different helpers still conflicts", async () => {
    const skill = `---
name: release
description: Prepare a safe release.
---
`;
    const session = fakeSession({
      ".agents/skills/release/SKILL.md": skill,
      ".agents/skills/release/helper.sh": "echo a\n",
      ".claude/skills/release/SKILL.md": skill,
      ".claude/skills/release/helper.sh": "echo b\n",
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

  test("lets native tool-bound Skills deterministically shadow workspace copies", async () => {
    const session = fakeSession({
      ".agents/skills/opengeni-documents/SKILL.md":
        "---\nname: opengeni-documents\ndescription: Repository copy.\n---\n",
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Repository release instructions.\n---\n",
    });
    await expect(
      discoverWorkspaceSkills(
        session,
        [{ path: ".agents/skills", source: ".agents/skills" }],
        new Set(),
        undefined,
        new Set(["opengeni-documents"]),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "release",
        description: "Repository release instructions.",
      }),
    ]);
  });

  test("deduplicates identical inline session skills and rejects conflicts", () => {
    const release = {
      name: "release",
      files: [{ path: "SKILL.md", content: "# Release\n" }],
    };
    expect(() =>
      buildAgentCapabilities(testSettings(), [
        sessionActivation(release, "one"),
        sessionActivation({ ...release, files: [...release.files] }, "two"),
      ]),
    ).not.toThrow();
    expect(() =>
      buildAgentCapabilities(testSettings(), [
        sessionActivation(release, "one"),
        sessionActivation(
          { name: "release", files: [{ path: "SKILL.md", content: "# Different\n" }] },
          "two",
        ),
      ]),
    ).toThrow('Conflicting Skill definitions for "release"');
  });
});

function sessionActivation(
  artifact: { name: string; files: Array<{ path: string; content: string }> },
  id: string,
) {
  return {
    source: "session" as const,
    id: `session:${id}`,
    artifact,
    reason: "attached to session",
  };
}

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
