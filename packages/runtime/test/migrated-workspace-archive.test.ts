import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureHostWorkspaceArchive } from "../src/sandbox/host-archive-spool";
import { establishSandboxSessionFromEnvelope } from "../src/sandbox/index";
import { testSettings } from "@opengeni/testing";
import { workspaceArchiveObjectKey } from "@opengeni/contracts";

for (const corruptDestination of [false, true]) {
  test(`Docker-format archive hydrates a remote provider with real tar/content verification (corrupt=${corruptDestination})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "migrated-workspace-test-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", "proof.txt"), "retained workspace bytes\n");
    const captured = await captureHostWorkspaceArchive(source, []);
    let creates = 0;
    let deletes = 0;
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000000000:${captured.spool.sha256}`,
      capturedAt: "2030-03-17T17:46:40.000Z",
      archiveSha256: captured.spool.sha256,
      archiveBytes: captured.spool.byteSize,
      workspace: captured.workspace,
    };
    try {
      const restore = establishSandboxSessionFromEnvelope(
        testSettings({ sandboxBackend: "modal" }),
        {
          backendId: "docker",
          sessionState: {
            workspaceArchiveMeta: descriptor,
            workspaceArchiveRef: {
              schema: "sandbox_archive_object_v1",
              backend: "s3-compatible",
              key: workspaceArchiveObjectKey({
                accountId: crypto.randomUUID(),
                workspaceId: crypto.randomUUID(),
                sandboxGroupId: crypto.randomUUID(),
                revision: descriptor.revision,
              }),
              sha256: captured.spool.sha256,
              bytes: captured.spool.byteSize,
            },
          },
        },
        {
          sessionId: crypto.randomUUID(),
          recovery: "create-or-restore",
          backendOverride: "modal",
          loadHostWorkspaceArchive: async () => captured.spool,
          clientFactory: () => ({
            backendId: "modal",
            async create() {
              creates++;
              return {
                state: { sandboxId: "sb-migrated", manifest: { root: destination } },
                async hydrateWorkspace(bytes: Uint8Array) {
                  const unpack = Bun.spawn(["tar", "-xf", "-", "-C", destination], {
                    stdin: bytes,
                    stderr: "pipe",
                  });
                  expect(await unpack.exited).toBe(0);
                  if (corruptDestination)
                    await writeFile(join(destination, "nested", "proof.txt"), "wrong contents");
                },
                async exec({ cmd }: { cmd: string }) {
                  const process = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
                  const [stdout, stderr, exitCode] = await Promise.all([
                    new Response(process.stdout).text(),
                    new Response(process.stderr).text(),
                    process.exited,
                  ]);
                  return { stdout, stderr, exitCode };
                },
              };
            },
            async delete() {
              deletes++;
            },
          }),
        },
      );
      if (corruptDestination) {
        await expect(restore).rejects.toMatchObject({ code: "workspace_fingerprint_mismatch" });
        expect(deletes).toBe(1);
      } else {
        const restored = await restore;
        expect(restored.restoredArchive?.revision).toBe(descriptor.revision);
        expect(await readFile(join(destination, "nested", "proof.txt"), "utf8")).toBe(
          "retained workspace bytes\n",
        );
        expect(deletes).toBe(0);
      }
      expect(creates).toBe(1);
    } finally {
      await captured.spool.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
