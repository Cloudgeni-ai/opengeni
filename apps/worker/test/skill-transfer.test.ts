import { describe, expect, test } from "bun:test";
import type { FsTreeNode } from "@opengeni/contracts";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  createSkillCheckoutAttemptToolDefinition,
  createSkillPublishAttemptToolDefinition,
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
  const writes: unknown[] = [];
  const dirs = new Set<string>();
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
    fsWrite: async (input: { path: string; content: string; overwrite: boolean }) => {
      writes.push(input);
      if (files.has(input.path) && !input.overwrite) throw new Error("exists");
      files.set(input.path, input.content);
      return { path: input.path, sizeBytes: Buffer.byteLength(input.content), revision: 1 };
    },
    fsMkdir: async ({ path, recursive }: { path: string; recursive: boolean }) => {
      if (dirs.has(path) && !recursive) throw new Error("exists");
      dirs.add(path);
      return { path, revision: 1 };
    },
  };
  return { fs, files, writes };
}

describe("optional Skill directory transfers", () => {
  test("checkout writes use mutation admission and recheck cancellation after admission", async () => {
    const { fs, writes } = fixture();
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
    expect(writes).toEqual([]);
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

  test("checkout preserves existing directories and uses non-overwriting writes", async () => {
    const { fs, writes } = fixture();
    expect(
      await checkoutSkillDirectory(fs, "new-checkout", [{ path: "SKILL.md", content: main }]),
    ).toEqual({ directory: "new-checkout", fileCount: 1 });
    expect(writes).toMatchObject([
      { path: "new-checkout/SKILL.md", overwrite: false, createParents: true },
    ]);
    await expect(
      checkoutSkillDirectory(fs, "new-checkout", [{ path: "SKILL.md", content: main }]),
    ).rejects.toThrow("exists");
    expect(writes).toHaveLength(1);
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
