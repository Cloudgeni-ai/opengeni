import { describe, expect, test } from "bun:test";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { SandboxInvalidManifestPathError } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing/settings";
import { SandboxFilesystemNotFoundError } from "modal";
import { buildAgentCapabilities } from "../src/index";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";

const decoder = new TextDecoder();

/** The pinned Agents Extensions Modal session over a fake box: its file
 * read/write (Modal's in-box filesystem tool, the same identity as the shell)
 * and the adapter's existence probe (`test -e`, then its read-path fallback)
 * and `rm` see one file map. Every other `exec` is the adapter's remote path
 * validator, recorded and refused. */
function modalSession(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const validations: string[][] = [];
  const exited = (code: number) => ({
    stdout: new ReadableStream(),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    wait: async () => code,
  });
  const sandbox = {
    exec: async (argv: string[]) => {
      if (argv[0] === "test" && argv[1] === "-e") return exited(files.has(argv[2]!) ? 0 : 1);
      const probed = argv[0] === "/bin/sh" ? /^test -e '([^']*)'/.exec(argv[2] ?? "") : null;
      if (probed) return exited(files.has(probed[1]!) ? 0 : 1);
      if (argv[0] === "rm") {
        files.delete(argv.at(-1)!);
        return exited(0);
      }
      validations.push(argv);
      throw new Error("unexpected exec in this fixture");
    },
    filesystem: {
      readBytes: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new SandboxFilesystemNotFoundError(`${path}: not found`);
        return new TextEncoder().encode(text);
      },
      writeBytes: async (bytes: Uint8Array, path: string) => {
        files.set(path, decoder.decode(bytes));
      },
    },
  };
  const raw = new ModalSandboxSession({
    state: { workspacePersistence: "tar", manifest: { root: "/workspace", extraPathGrants: [] } },
    modal: { version: () => "0.9.0" },
    sandbox,
    app: {},
  } as never);
  return { raw, files, validations };
}

function modelTools(session: unknown) {
  const [filesystemCapability] = buildAgentCapabilities(testSettings(), [], {
    structuredToolTransport: false,
    supportsImageInput: true,
  });
  return (filesystemCapability as any).bind(session).tools();
}

function modelApplyPatch(session: unknown) {
  const tool = modelTools(session).find(
    (candidate: { name?: string }) => candidate.name === "apply_patch",
  );
  return async (patch: string) =>
    String(
      await tool.invoke(undefined, JSON.stringify({ patch }), {
        toolCall: { callId: "call-patch" },
      }),
    );
}

describe("Modal apply_patch writes where the shell writes", () => {
  test("the adapter alone refuses a scratch file under /tmp", async () => {
    // The production defect: the instructions put throwaway scripts outside
    // the project, and apply_patch then refused /tmp.
    const { raw, files } = modalSession();
    await expect(
      raw.createEditor().createFile({ type: "create_file", path: "/tmp/check.ts", diff: "+x" }),
    ).rejects.toBeInstanceOf(SandboxInvalidManifestPathError);
    expect(files.size).toBe(0);
  });

  test("an installed Modal session creates, updates, moves and deletes files under /tmp", async () => {
    const { raw, files, validations } = modalSession();
    const editor = installOpenGeniModalSnapshotPolicy(raw).createEditor();

    await editor.createFile({ type: "create_file", path: "/tmp/check.ts", diff: "+one" });
    expect(files.get("/tmp/check.ts")).toBe("one");
    await editor.updateFile({
      type: "update_file",
      path: "/tmp/check.ts",
      diff: "@@\n-one\n+two",
      moveTo: "/tmp/scratch/check.ts",
    });
    expect([...files]).toEqual([["/tmp/scratch/check.ts", "two"]]);
    await editor.deleteFile({ type: "delete_file", path: "/tmp/scratch/check.ts" });
    expect(files.size).toBe(0);
    // No remote path-validation command for any of them.
    expect(validations).toEqual([]);
  });

  test("paths resolve the way the shell resolves them from the workspace root", async () => {
    const { raw, files } = modalSession();
    const editor = installOpenGeniModalSnapshotPolicy(raw).createEditor();
    await editor.createFile({ type: "create_file", path: "src/a.ts", diff: "+a" });
    await editor.createFile({ type: "create_file", path: "/workspace/src/b.ts", diff: "+b" });
    await editor.createFile({ type: "create_file", path: "../tmp/c.ts", diff: "+c" });
    expect([...files.keys()]).toEqual(["/workspace/src/a.ts", "/workspace/src/b.ts", "/tmp/c.ts"]);
  });

  test("an existing file still refuses Add File", async () => {
    const { raw } = modalSession({ "/tmp/check.ts": "old" });
    const editor = installOpenGeniModalSnapshotPolicy(raw).createEditor();
    await expect(
      editor.createFile({ type: "create_file", path: "/tmp/check.ts", diff: "+new" }),
    ).rejects.toThrow("Cannot create file because it already exists: /tmp/check.ts");
  });

  test("a runAs editor keeps the adapter's user-scoped path", async () => {
    const { raw, files } = modalSession();
    const editor = installOpenGeniModalSnapshotPolicy(raw).createEditor("agent");
    await expect(
      editor.createFile({ type: "create_file", path: "/tmp/check.ts", diff: "+x" }),
    ).rejects.toBeInstanceOf(SandboxInvalidManifestPathError);
    expect(files.size).toBe(0);
  });

  test("the model's apply_patch tool writes the /tmp scratch file", async () => {
    const { raw, files } = modalSession();
    const applyPatch = modelApplyPatch(installOpenGeniModalSnapshotPolicy(raw));
    const output = await applyPatch(
      "*** Begin Patch\n*** Add File: /tmp/check.ts\n+console.log(1);\n*** End Patch",
    );
    expect(output).not.toContain("escapes the workspace root");
    expect(files.get("/tmp/check.ts")).toBe("console.log(1);\n");
  });

  test("the model sees the same tools: only what an edit is allowed to touch changes", () => {
    const definitions = (session: unknown) =>
      modelTools(session).map((tool: Record<string, unknown>) =>
        JSON.stringify({
          type: tool.type,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      );
    expect(definitions(installOpenGeniModalSnapshotPolicy(modalSession().raw))).toEqual(
      definitions(modalSession().raw),
    );
  });
});
