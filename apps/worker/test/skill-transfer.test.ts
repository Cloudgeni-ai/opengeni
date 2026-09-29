import { describe, expect, test } from "bun:test";
import type { FsTreeNode } from "@opengeni/contracts";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  createSkillCheckoutAttemptToolDefinition,
  createSkillPublishAttemptToolDefinition,
  type SkillCheckoutObservation,
} from "../src/activities/agent-turn/skill-checkout";
import {
  checkoutSkillDirectory,
  guardSkillFilesystem,
  readSkillDirectory,
} from "../src/activities/agent-turn/skill-transfer";

const main = "---\nname: deploy\ndescription: Deploy a service\n---\n# Deploy\n";
const node = (path: string, type: FsTreeNode["type"], children?: FsTreeNode[]): FsTreeNode => ({
  path,
  name: path.split("/").at(-1)!,
  type,
  sizeBytes: null,
  mtimeMs: null,
  mode: null,
  truncated: false,
  ...(children ? { children } : {}),
});

function fixture() {
  const files = new Map<string, string>([
    ["checkout/SKILL.md", main],
    ["checkout/references/a.md", "\ufeffreference\n"],
  ]);
  type Batch = {
    directory: string;
    files: readonly { path: string; content: string; encoding?: string }[];
  };
  const batches: Batch[] = [];
  const dirs = new Set<string>(["checkout", "checkout/references"]);
  const fs = {
    fsList: async ({ path }: { path: string }) => ({
      root: node(
        path,
        "dir",
        path === "checkout"
          ? [node("checkout/SKILL.md", "file"), node("checkout/references", "dir")]
          : [node("checkout/references/a.md", "file")],
      ),
      revision: 1,
      truncated: false,
    }),
    fsRead: async ({ path }: { path: string }) => {
      const bytes = Buffer.from(files.get(path)!, "utf8");
      return {
        path,
        content: bytes.toString("base64"),
        sizeBytes: bytes.byteLength,
        encoding: "base64" as const,
        truncated: false,
        isBinary: false,
        revision: 1,
      };
    },
    // Mirrors SandboxChannelAService.fsWriteFiles: create missing files, keep
    // identical ones, and refuse any different existing file before writing.
    fsWriteFiles: async (request: Batch) => {
      batches.push(request);
      const written: string[] = [];
      const unchanged: string[] = [];
      for (const file of request.files) {
        const existing = files.get(`${request.directory}/${file.path}`);
        if (existing === undefined) written.push(file.path);
        else if (existing === file.content) unchanged.push(file.path);
        else throw new Error(`path exists with different content: ${file.path}`);
      }
      const createdDirectory = !dirs.has(request.directory);
      dirs.add(request.directory);
      for (const file of request.files) {
        files.set(`${request.directory}/${file.path}`, file.content);
      }
      return { directory: request.directory, written, unchanged, createdDirectory, revision: 1 };
    },
  };
  return { fs, files, batches };
}

describe("optional Skill directory transfers", () => {
  test("checkout writes use mutation admission and recheck cancellation after admission", async () => {
    const { fs, batches } = fixture();
    let active = true;
    let admissions = 0;
    const guarded = guardSkillFilesystem(fs, {
      assertActive: () => {
        if (!active) throw new Error("attempt cancelled");
      },
      runMutation: async (operation) => {
        admissions++;
        active = false;
        return operation();
      },
    });
    await expect(
      checkoutSkillDirectory(guarded, "fresh", [{ path: "SKILL.md", content: main }]),
    ).rejects.toThrow("attempt cancelled");
    expect(admissions).toBe(1);
    expect(batches).toEqual([]);
  });
  test("gateway checkout is lazy and publish uses the governed save receipt", async () => {
    const { fs } = fixture();
    const calls: string[] = [];
    const skillId = "88888888-8888-4888-8888-888888888888";
    const revisionId = "66666666-6666-4666-8666-666666666666";
    const operationId = "77777777-7777-4777-8777-777777777777";
    const authorize = async () => {
      calls.push("authorize");
    };
    const filesystem = async () => {
      calls.push("filesystem");
      return fs;
    };
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions: [
        createSkillCheckoutAttemptToolDefinition({
          authorize,
          filesystem,
          load: async () => {
            calls.push("load");
            return {
              skillId,
              revisionId,
              scopeVersion: 2,
              files: [{ path: "SKILL.md", content: main }],
            };
          },
        }),
        createSkillPublishAttemptToolDefinition({
          authorize,
          filesystem,
          save: async (request) => {
            calls.push("save");
            expect(request.files).toContainEqual({
              path: "references/a.md",
              content: "\ufeffreference\n",
            });
            expect(request.expectedRevisionId).toBe(revisionId);
            return { operationId, skillId, revisionId, outcome: "pending", replayed: false };
          },
        }),
      ],
    });
    expect(calls).toEqual([]);
    const checkout = await environment.callModel({
      modelName: "skill_checkout",
      subjectId: "agent:test",
      arguments: { skill: skillId, directory: "fresh" },
    });
    expect(calls).toEqual(["authorize", "load", "filesystem"]);
    expect(checkout.structuredContent).toMatchObject({ skillId, revisionId, scopeVersion: 2 });
    const publish = await environment.callModel({
      modelName: "skill_publish",
      subjectId: "agent:test",
      arguments: {
        operationId,
        skillId,
        expectedRevisionId: revisionId,
        expectedScopeVersion: 2,
        directory: "checkout",
        reason: "Update",
      },
    });
    expect(calls.slice(3)).toEqual(["authorize", "filesystem", "save"]);
    expect(publish.structuredContent).toMatchObject({ outcome: "pending" });
  });

  test("reads nested text using structured filesystem calls and preserves BOM", async () => {
    const { fs } = fixture();
    const artifact = await readSkillDirectory(fs, "checkout");
    expect(artifact.files).toEqual([
      { path: "SKILL.md", content: main },
      { path: "references/a.md", content: "\ufeffreference\n" },
    ]);
  });

  test("checkout writes every file in one batch and a repeat keeps identical files", async () => {
    const { fs, batches } = fixture();
    const skill = [
      { path: "scripts/run.py", content: "print(1)\n" },
      { path: "SKILL.md", content: main },
    ];
    expect(await checkoutSkillDirectory(fs, "new-checkout", skill)).toEqual({
      directory: "new-checkout",
      fileCount: 2,
      written: 2,
      unchanged: 0,
      createdDirectory: true,
    });
    expect(batches).toHaveLength(1);
    // The canonical artifact order, not the stored order.
    expect(batches[0]!.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(await checkoutSkillDirectory(fs, "new-checkout", skill)).toEqual({
      directory: "new-checkout",
      fileCount: 2,
      written: 0,
      unchanged: 2,
      createdDirectory: false,
    });
    await expect(
      checkoutSkillDirectory(fs, "new-checkout", [{ path: "SKILL.md", content: `${main}edit` }]),
    ).rejects.toThrow("different content");
  });

  test("checkout paths copy exactly the named files", async () => {
    const { fs, batches } = fixture();
    const skill = [
      { path: "SKILL.md", content: main },
      { path: "scripts/a.py", content: "a\n" },
      { path: "scripts/b.py", content: "b\n" },
    ];
    expect(
      await checkoutSkillDirectory(fs, "one", skill, { paths: ["scripts/b.py"] }),
    ).toMatchObject({ fileCount: 1, written: 1 });
    expect(batches[0]!.files).toEqual([{ path: "scripts/b.py", content: "b\n", encoding: "utf8" }]);
    await expect(
      checkoutSkillDirectory(fs, "two", skill, { paths: ["scripts/missing.py"] }),
    ).rejects.toThrow("not found");
    await expect(
      checkoutSkillDirectory(fs, "two", skill, { paths: ["scripts/a.py", "scripts/a.py"] }),
    ).rejects.toThrow("Duplicate");
    await expect(
      checkoutSkillDirectory(fs, "two", skill, { paths: ["../SKILL.md"] }),
    ).rejects.toThrow("safe relative");
    await expect(checkoutSkillDirectory(fs, "two", skill, { paths: [] })).rejects.toThrow(
      "Request between",
    );
    expect(batches).toHaveLength(1);
  });

  test("only a complete checkout into a new directory returns a publish base", async () => {
    const { fs } = fixture();
    const skillId = "88888888-8888-4888-8888-888888888888";
    const revisionId = "66666666-6666-4666-8666-666666666666";
    const observations: SkillCheckoutObservation[] = [];
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions: [
        createSkillCheckoutAttemptToolDefinition({
          authorize: async () => {},
          filesystem: async () => fs,
          load: async (skill) => {
            if (skill !== skillId) throw new Error("Skill is not available in this session.");
            return {
              skillId,
              revisionId,
              scopeVersion: 2,
              files: [
                { path: "SKILL.md", content: main },
                { path: "scripts/run.py", content: "print(1)\n" },
              ],
            };
          },
          observe: (observation) => observations.push(observation),
        }),
      ],
    });
    const call = (args: Record<string, unknown>) =>
      environment.callModel({
        modelName: "skill_checkout",
        subjectId: "agent:test",
        arguments: args,
      });

    expect((await call({ skill: skillId, directory: "fresh" })).structuredContent).toEqual({
      directory: "fresh",
      fileCount: 2,
      written: 2,
      unchanged: 0,
      skillId,
      revisionId,
      scopeVersion: 2,
    });
    expect((await call({ skill: skillId, directory: "fresh" })).structuredContent).toEqual({
      directory: "fresh",
      fileCount: 2,
      written: 0,
      unchanged: 2,
      skillId,
      publishable: false,
    });
    expect(
      (await call({ skill: skillId, directory: "partial", paths: ["scripts/run.py"] }))
        .structuredContent,
    ).toEqual({
      directory: "partial",
      fileCount: 1,
      written: 1,
      unchanged: 0,
      skillId,
      publishable: false,
    });
    await expect(call({ skill: "unknown", directory: "other" })).rejects.toThrow("not available");

    expect(
      observations.map(({ outcome, selection, written, unchanged }) => ({
        outcome,
        selection,
        written,
        unchanged,
      })),
    ).toEqual([
      { outcome: "written", selection: "all", written: 2, unchanged: 0 },
      { outcome: "unchanged", selection: "all", written: 0, unchanged: 2 },
      { outcome: "written", selection: "paths", written: 1, unchanged: 0 },
      { outcome: "refused", selection: "all", written: 0, unchanged: 0 },
    ]);
    for (const observation of observations.slice(0, 3)) {
      expect(observation.resolveSeconds).toBeGreaterThanOrEqual(0);
      expect(observation.sandboxSeconds).toBeGreaterThanOrEqual(0);
      expect(observation.writeSeconds).toBeGreaterThanOrEqual(0);
      expect(observation.totalSeconds).toBeGreaterThanOrEqual(observation.writeSeconds!);
    }
    // A refused checkout never reached the sandbox.
    expect(observations[3]).toMatchObject({ sandboxSeconds: null, writeSeconds: null });
  });

  test("rejects incomplete listings and symlinks rather than dropping files", async () => {
    const { fs } = fixture();
    await expect(
      readSkillDirectory(
        {
          ...fs,
          fsList: async () => ({ root: node("checkout", "dir", []), revision: 1, truncated: true }),
        },
        "checkout",
      ),
    ).rejects.toThrow("incomplete");
    await expect(
      readSkillDirectory(
        {
          ...fs,
          fsList: async () => ({
            root: node("checkout", "dir", [node("checkout/link", "symlink")]),
            revision: 1,
            truncated: false,
          }),
        },
        "checkout",
      ),
    ).rejects.toThrow("Unsupported");
  });

  test("rejects returned paths outside the requested folder", async () => {
    const { fs } = fixture();
    await expect(
      readSkillDirectory(
        {
          ...fs,
          fsList: async () => ({
            root: node("checkout", "dir", [node("other/file", "file")]),
            revision: 1,
            truncated: false,
          }),
        },
        "checkout",
      ),
    ).rejects.toThrow("outside");
  });

  test("rejects binary bytes and truncated file contents", async () => {
    const { fs } = fixture();
    const raw = {
      path: "checkout/SKILL.md",
      content: Buffer.from([0xff]).toString("base64"),
      sizeBytes: 1,
      encoding: "base64" as const,
      truncated: false,
      isBinary: true,
      revision: 1,
    };
    await expect(
      readSkillDirectory({ ...fs, fsRead: async () => raw }, "checkout"),
    ).rejects.toThrow("UTF-8");
    await expect(
      readSkillDirectory({ ...fs, fsRead: async () => ({ ...raw, truncated: true }) }, "checkout"),
    ).rejects.toThrow("size limit");
  });
});
