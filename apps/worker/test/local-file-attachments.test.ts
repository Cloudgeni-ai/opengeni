import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { buildManifest, materializeSandboxFileDownloads } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { requiresSignedFileResourceDownloads } from "../src/activities/agent-turn/file-resources";

// The pinned SDK applies this exact guard when a turn reuses a provided box.
const { applyManifestToProvidedSession } = await import(
  new URL(
    "./sandbox/runtime/providedSessionManifest.mjs",
    import.meta.resolve("@openai/agents-core"),
  ).href
);

for (const objectStorageBackend of ["s3-compatible", "azure-blob"] as const) {
  test.skipIf(process.platform === "win32")(
    `a reused local sandbox reads later ${objectStorageBackend} attachments without adding mounts`,
    async () => {
      const settings = testSettings({
        sandboxBackend: "local",
        objectStorageBackend,
        objectStorageEndpoint: "https://storage.example.test",
        objectStorageAccessKeyId: "fixture-access",
        objectStorageSecretAccessKey: "fixture-secret",
        objectStorageAzureAccountName: "fixtureaccount",
        objectStorageAzureAccountKey: Buffer.from("fixture-key").toString("base64"),
      });
      const sourceRoot = await mkdtemp(join(tmpdir(), "local-attachment-source-"));
      const session = await new UnixLocalSandboxClient().create(new Manifest());
      try {
        // Each iteration represents a later message with a new uploaded file.
        // No live model or storage credential is needed: signed GET transport is
        // a local fixture, but manifest application and sandbox reads are real.
        for (const fileId of ["attachment-one", "attachment-two"]) {
          const content = `exact bytes for ${fileId}`;
          const filename = `${fileId}.txt`;
          const source = join(sourceRoot, filename);
          await writeFile(source, content);
          const mountPath = `.opengeni/files/${fileId}`;
          const downloads = requiresSignedFileResourceDownloads(settings)
            ? [
                {
                  fileId,
                  mountPath,
                  filename,
                  url: pathToFileURL(source).href,
                  sizeBytes: Buffer.byteLength(content),
                  sha256: createHash("sha256").update(content).digest("hex"),
                },
              ]
            : [];
          const manifest = buildManifest(settings, [{ kind: "file", fileId }], {}, downloads);
          await applyManifestToProvidedSession(session, manifest);
          expect((await materializeSandboxFileDownloads(session, downloads)).failures).toEqual([]);
          expect((await session.readFile({ path: `${mountPath}/${filename}` })).toString()).toBe(
            content,
          );
        }
        expect(
          (
            await session.readFile({ path: ".opengeni/files/attachment-one/attachment-one.txt" })
          ).toString(),
        ).toBe("exact bytes for attachment-one");
      } finally {
        await session.delete();
        await rm(sourceRoot, { recursive: true, force: true });
      }
    },
  );
}
