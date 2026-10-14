// A deployment that switches sandbox backend must not strand chats archived
// before the switch. A host-backed (Local/Docker) archive restores into a
// remote sandbox by hydrating a portable tar converted from it, then verifies
// every restored directory and file against the archive.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  captureWorkspaceArchiveForStorage,
  disposeWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
  terminateManagedSandboxSession,
} from "@opengeni/runtime/sandbox";
import { downloadWorkspaceArchiveSpool, type ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing";
import { putVersion1TarArchiveOrInline } from "../src/sandbox-archive-storage";

// The validator the remote providers run before extracting a workspace tar.
const { validateWorkspaceTarArchive } = (await import(
  join(
    dirname(
      Bun.resolveSync(
        "@openai/agents-extensions/sandbox/modal",
        join(import.meta.dir, "../../../packages/runtime"),
      ),
    ),
    "../shared/archive.mjs",
  )
)) as { validateWorkspaceTarArchive: (data: Uint8Array, options: object) => void };

const LONG_DIRECTORY = `deep/${"nested-directory-name-".repeat(6)}`;
const SOURCE_FILES: Record<string, string> = {
  "README.md": "# Project\n",
  "src/index.ts": "export const answer = 42;\n",
  "src/-leading-dash.txt": "dash\n",
  "notes/with space.txt": "space\n",
  "notes/sjø og æble.txt": "unicode\n",
  [`${LONG_DIRECTORY}/a-file-whose-full-path-is-longer-than-one-hundred-bytes.txt`]: "long\n",
  "empty.txt": "",
  "notes/line\nbreak.txt": "newline in name\n",
};

function memoryStorage() {
  let stored = Buffer.alloc(0);
  return {
    backend: "s3-compatible",
    async putObjectStream(input: { chunks: AsyncIterable<Uint8Array> }) {
      const parts: Buffer[] = [];
      for await (const bytes of input.chunks) parts.push(Buffer.from(bytes));
      stored = Buffer.concat(parts);
    },
    async headObject() {
      return { ContentLength: stored.length, VersionToken: "v1" };
    },
    async getObjectRange(input: { start: number; endInclusive: number }) {
      return { bytes: stored.subarray(input.start, input.endInclusive + 1), versionToken: "v1" };
    },
    async getObjectBytes(): Promise<never> {
      throw new Error("whole-object download forbidden");
    },
    async putObject(): Promise<never> {
      throw new Error("whole-object upload forbidden");
    },
  } as unknown as ObjectStorage;
}

async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result[`${path}/`] = "dir";
      Object.assign(result, await tree(root, path));
    } else {
      result[path] = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
    }
  }
  return result;
}

async function run(cmd: string) {
  const child = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A remote-style provider: no host workspace root, a manifest root, tar
 * hydration that replaces the root's contents, and shell execution. */
function remoteClientFactory(
  root: string,
  hydrated: { calls: number },
  tamper = false,
  ephemeral: string[] = [],
) {
  return () => ({
    backendId: "modal",
    async create() {
      const session = {
        state: {
          sandboxId: "sb-remote",
          manifest: { root, ephemeralPersistencePaths: () => new Set<string>(ephemeral) },
        },
        async exec(args: { cmd: string }) {
          return await run(args.cmd);
        },
        async hydrateWorkspace(data: Uint8Array) {
          hydrated.calls += 1;
          validateWorkspaceTarArchive(data, { allowSymlinks: false, rejectRelPaths: [] });
          const archive = join(dirname(root), "hydrate.tar");
          await writeFile(archive, data);
          const result = await run(
            `find '${root}' -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C '${root}' -xf '${archive}'`,
          );
          if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr}`);
          if (tamper) await writeFile(join(root, "README.md"), "changed\n");
        },
      };
      return session;
    },
    async delete() {},
  });
}

test.skipIf(process.platform !== "linux")(
  "a host-backed archive restores into a remote sandbox after the backend changes",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opengeni-cross-backend-"));
    const remoteRoot = join(scratch, "workspace");
    await mkdir(remoteRoot);
    const settings = testSettings({ sandboxBackend: "local" });
    const source = await establishSandboxSessionFromEnvelope(settings, null, {
      sessionId: "cross-backend-source",
      recovery: "create-or-restore",
      backendOverride: "local",
      environment: {},
    });
    const sourceRoot = (source.session as { state: { workspaceRootPath: string } }).state
      .workspaceRootPath;
    let archive: Awaited<ReturnType<typeof captureWorkspaceArchiveForStorage>> | undefined;
    try {
      for (const [path, content] of Object.entries(SOURCE_FILES)) {
        await mkdir(join(sourceRoot, dirname(path)), { recursive: true });
        await writeFile(join(sourceRoot, path), content);
      }
      await mkdir(join(sourceRoot, "empty-directory"));
      archive = await captureWorkspaceArchiveForStorage(
        source.session,
        1_900_000_000_000,
        { requestId: "11111111-1111-4111-8111-111111111111" },
        true,
      );
      expect(archive.kind).toBe("host_spool");
      expect(archive.descriptor.workspace.projection).toBe("sdk_local_archive_v1");
      const storage = memoryStorage();
      const published = await putVersion1TarArchiveOrInline({
        backend: "docker",
        objectStorage: storage,
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sandboxGroupId: "33333333-3333-4333-8333-333333333333",
        archive,
      });
      const envelope = {
        sessionState: { ...published, workspaceArchiveMeta: archive.descriptor },
      };
      const restoreWith = (
        tamper: boolean,
        hydrated: { calls: number },
        ephemeral: string[] = [],
      ) =>
        establishSandboxSessionFromEnvelope(testSettings({ sandboxBackend: "modal" }), envelope, {
          sessionId: "cross-backend-restored",
          recovery: "create-or-restore",
          backendOverride: "modal",
          environment: {},
          clientFactory: remoteClientFactory(remoteRoot, hydrated, tamper, ephemeral) as never,
          loadHostWorkspaceArchive: (ref) =>
            downloadWorkspaceArchiveSpool(storage, ref.key, {
              bytes: ref.bytes,
              sha256: ref.sha256,
            }),
        });

      const hydrated = { calls: 0 };
      const restored = await restoreWith(false, hydrated);
      expect(hydrated.calls).toBe(1);
      expect(restored.origin).toBe("restored");
      expect(restored.restoredArchive?.revision).toBe(archive.descriptor.revision);
      expect(await tree(remoteRoot)).toEqual(await tree(sourceRoot));
      expect((await stat(join(remoteRoot, "empty-directory"))).isDirectory()).toBe(true);

      // A restored tree that differs from the archive is never published.
      const tampered = { calls: 0 };
      const failure = await restoreWith(true, tampered).then(
        () => null,
        (error: unknown) => error,
      );
      expect(tampered.calls).toBe(1);
      expect(failure).toMatchObject({ code: "workspace_fingerprint_mismatch" });

      // The destination's ephemeral paths are not persisted there: they are left
      // out of the hydrated tree and of its verification.
      const withEphemeral = await restoreWith(false, { calls: 0 }, ["notes"]);
      expect(withEphemeral.origin).toBe("restored");
      const expected = Object.fromEntries(
        Object.entries(await tree(sourceRoot)).filter(([path]) => !path.startsWith("notes/")),
      );
      expect(await tree(remoteRoot)).toEqual(expected);
    } finally {
      if (archive) await disposeWorkspaceArchive(archive);
      await terminateManagedSandboxSession(source.client, source.sessionState, source.session);
      await rm(scratch, { recursive: true, force: true });
    }
  },
  60_000,
);
