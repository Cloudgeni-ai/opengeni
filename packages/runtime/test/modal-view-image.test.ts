import { describe, expect, test } from "bun:test";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { SandboxInvalidManifestPathError } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing/settings";
import { SandboxFilesystemNotFoundError } from "modal";
import { buildAgentCapabilities } from "../src/index";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";

// A 1x1 PNG, as `pdftoppm -png` writes one.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

/** The pinned Agents Extensions Modal session over a fake box whose file read
 * (Modal's in-box filesystem tool, the same identity as the shell) sees the
 * files the shell wrote. Every `exec` is recorded: the adapter's path
 * validator runs as one. */
function modalSession(files: Record<string, Uint8Array>) {
  const reads: string[] = [];
  const execs: string[][] = [];
  const sandbox = {
    exec: async (argv: string[]) => {
      execs.push(argv);
      throw new Error("unexpected exec in this fixture");
    },
    filesystem: {
      readBytes: async (path: string) => {
        reads.push(path);
        const bytes = files[path];
        if (!bytes) throw new SandboxFilesystemNotFoundError(`${path}: not found`);
        return bytes;
      },
    },
  };
  const raw = new ModalSandboxSession({
    state: { workspacePersistence: "tar", manifest: { root: "/workspace", extraPathGrants: [] } },
    modal: { version: () => "0.9.0" },
    sandbox,
    app: {},
  } as never);
  return { raw, reads, execs };
}

describe("Modal view_image reads what the shell can read", () => {
  test("the adapter alone refuses an image the shell rendered to /tmp", async () => {
    // The production defect: `pdftoppm -png doc.pdf /tmp/x` then view_image.
    const { raw, reads } = modalSession({ "/tmp/x-1.png": PNG });
    await expect(raw.viewImage({ path: "/tmp/x-1.png" })).rejects.toBeInstanceOf(
      SandboxInvalidManifestPathError,
    );
    expect(reads).toEqual([]);
  });

  test("an installed Modal session reads it through the box's own file read", async () => {
    const { raw, reads, execs } = modalSession({ "/tmp/x-1.png": PNG });
    const session = installOpenGeniModalSnapshotPolicy(raw);

    await expect(session.viewImage({ path: "/tmp/x-1.png" })).resolves.toEqual({
      type: "image",
      image: { data: PNG, mediaType: "image/png" },
    });
    expect(reads).toEqual(["/tmp/x-1.png"]);
    // No separate path-validation command: one provider round trip per image.
    expect(execs).toEqual([]);
  });

  test("paths resolve the way the shell resolves them from the workspace root", async () => {
    const { raw, reads } = modalSession({
      "/workspace/renders/a.png": PNG,
      "/tmp/x-1.png": PNG,
    });
    const session = installOpenGeniModalSnapshotPolicy(raw);

    for (const path of ["renders/a.png", "/workspace/renders/a.png", "../tmp/x-1.png"]) {
      await expect(session.viewImage({ path })).resolves.toMatchObject({ type: "image" });
    }
    expect(reads).toEqual(["/workspace/renders/a.png", "/workspace/renders/a.png", "/tmp/x-1.png"]);
  });

  test("a missing file stays a typed path miss", async () => {
    const session = installOpenGeniModalSnapshotPolicy(modalSession({}).raw);
    await expect(session.viewImage({ path: "/tmp/missing.png" })).rejects.toBeInstanceOf(
      SandboxFilesystemNotFoundError,
    );
  });

  test("a runAs read keeps the adapter's user-scoped path", async () => {
    const { raw, reads } = modalSession({ "/tmp/x-1.png": PNG });
    const session = installOpenGeniModalSnapshotPolicy(raw);
    await expect(
      session.viewImage({ path: "/tmp/x-1.png", runAs: "agent" }),
    ).rejects.toBeInstanceOf(SandboxInvalidManifestPathError);
    expect(reads).toEqual([]);
  });

  test("the model's view_image tool returns the /tmp image", async () => {
    const { raw } = modalSession({ "/tmp/x-1.png": PNG });
    const session = installOpenGeniModalSnapshotPolicy(raw);
    const [filesystemCapability] = buildAgentCapabilities(testSettings(), [], {
      structuredToolTransport: false,
      supportsImageInput: true,
    });
    const bound = (filesystemCapability as any).bind(session);
    const viewImage = bound.tools().find((tool: { name?: string }) => tool.name === "view_image");
    const output = await viewImage.invoke(undefined, '{"path":"/tmp/x-1.png"}', {
      toolCall: { callId: "call-view" },
    });
    expect(output).toMatchObject({
      type: "image",
      image: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
  });
});
