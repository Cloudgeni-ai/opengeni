import { afterEach, describe, expect, test } from "bun:test";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectSandboxVideoReferences,
  uploadAndVerifyVideoReferences,
  VideoReferenceInputError,
  type SandboxCommandRunner,
} from "../src/activities/video-reference-staging";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-video-reference-"));
  roots.push(root);
  return root;
}

function localCommandRunner(root: string, observed?: string[]): SandboxCommandRunner {
  return async ({ cmd, workdir }) => {
    expect(workdir).toBe("/workspace");
    observed?.push(cmd);
    const child = Bun.spawn(["bash", "-lc", cmd], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
}

describe("video reference staging", () => {
  test("inspects a materialized /workspace image through the real macOS/Linux shell", async () => {
    const root = await workspace();
    await mkdir(join(root, "generated-images"));
    await writeFile(join(root, "generated-images", "frame.png"), PNG);
    const commands: string[] = [];

    const [reference] = await inspectSandboxVideoReferences({
      request: {
        prompt: "animate",
        source: {
          mode: "first_frame",
          imagePath: "/workspace/generated-images/frame.png",
        },
      },
      runCommand: localCommandRunner(root, commands),
    });

    expect(reference).toEqual({
      ordinal: 0,
      role: "first_frame",
      path: "/workspace/generated-images/frame.png",
      contentType: "image/png",
      sizeBytes: PNG.byteLength,
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });
    expect(commands[0]).toContain("requested='./generated-images/frame.png'");
    expect(commands[0]).not.toContain("realpath -e");
  });

  test("rejects missing and symlink-escaped references before admission", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "outside.png"), PNG);
    await mkdir(join(root, "generated-images"));
    await symlink(join(outside, "outside.png"), join(root, "generated-images", "escaped.png"));

    for (const imagePath of [
      "/workspace/generated-images/missing.png",
      "/workspace/generated-images/escaped.png",
    ]) {
      await expect(
        inspectSandboxVideoReferences({
          request: {
            prompt: "animate",
            source: { mode: "first_frame", imagePath },
          },
          runCommand: localCommandRunner(root),
        }),
      ).rejects.toMatchObject({
        name: "VideoReferenceInputError",
        code: "reference_not_stable",
      });
    }
  });

  test("uploads and verifies the same materialized image with portable shell commands", async () => {
    const root = await workspace();
    await mkdir(join(root, "generated-images"));
    await writeFile(join(root, "generated-images", "frame.png"), PNG);
    const [reference] = await inspectSandboxVideoReferences({
      request: {
        prompt: "animate",
        source: {
          mode: "first_frame",
          imagePath: "/workspace/generated-images/frame.png",
        },
      },
      runCommand: localCommandRunner(root),
    });
    if (!reference) throw new Error("reference inspection failed");

    let uploaded: Uint8Array | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method !== "PUT") return new Response(null, { status: 405 });
        uploaded = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 200 });
      },
    });
    const sha256 = reference.sha256;
    const storage = {
      bucket: "test",
      backend: "s3-compatible",
      maxSinglePutSizeBytes: 5_000_000_000,
      createPutUrl: async () => ({
        url: `http://127.0.0.1:${server.port}/reference`,
        requiredHeaders: { "content-type": "image/png" },
        expiresAt: new Date(Date.now() + 60_000),
      }),
      headObject: async () =>
        uploaded
          ? {
              ContentLength: uploaded.byteLength,
              ContentType: "image/png",
              Metadata: { sha256 },
              VersionToken: "v1",
            }
          : null,
      getObjectRange: async ({ start, endInclusive }: { start: number; endInclusive: number }) =>
        uploaded
          ? {
              bytes: uploaded.slice(start, endInclusive + 1),
              versionToken: "v1",
            }
          : null,
    } as unknown as ObjectStorage;

    try {
      await expect(
        uploadAndVerifyVideoReferences({
          storage,
          references: [reference],
          stagingKeys: ["staging/reference"],
          runCommand: localCommandRunner(root),
          tempRoot: join(root, "verified"),
          ffprobePath: "ffprobe",
          uploadTtlSeconds: 60,
        }),
      ).resolves.toEqual([
        {
          role: "first_frame",
          contentSha256: sha256,
          contentType: "image/png",
          byteSize: PNG.byteLength,
        },
      ]);
      expect(uploaded).toEqual(new Uint8Array(PNG));
    } finally {
      server.stop(true);
    }
  });

  test("rejects non-canonical /workspace paths without running shell code", async () => {
    let called = false;
    const promise = inspectSandboxVideoReferences({
      request: {
        prompt: "animate",
        source: {
          mode: "first_frame",
          imagePath: "/workspace/generated-images/../frame.png",
        },
      },
      runCommand: async () => {
        called = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await expect(promise).rejects.toBeInstanceOf(VideoReferenceInputError);
    expect(called).toBe(false);
  });
});
