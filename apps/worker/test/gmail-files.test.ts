import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ObjectStorage } from "@opengeni/storage";
import { materializeGmailFile, readGmailFileFromChannel } from "../src/activities/gmail-files";
import {
  RoutingMutationOutcomeUnknownError,
  SandboxChannelAService,
} from "@opengeni/runtime/sandbox";

const fileRoot = mkdtempSync(join(tmpdir(), "opengeni-gmail-file-"));
afterAll(() => rmSync(fileRoot, { recursive: true, force: true }));

describe("Gmail confined filesystem inputs", () => {
  const channel = new SandboxChannelAService({
    workspaceRoot: fileRoot,
    providerPathMode: "workspace-relative",
    session: {
      exec: async ({ cmd }) => {
        const result = spawnSync("bash", ["--noprofile", "--norc", "-c", cmd], {
          cwd: fileRoot,
          encoding: "utf8",
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
      },
    },
  });

  test("reads binary and empty files in the selected machine root at the exact byte limit", async () => {
    for (const bytes of [Buffer.from([0, 255, 128]), Buffer.alloc(0)]) {
      writeFileSync(join(fileRoot, "fixture.bin"), bytes);
      expect(
        Buffer.from(
          await readGmailFileFromChannel(channel, {
            path: "fixture.bin",
            maxBytes: bytes.length,
          }),
        ),
      ).toEqual(bytes);
    }
  });

  test("rejects oversized inputs, parent escapes and symlinks before any provider write", async () => {
    writeFileSync(join(fileRoot, "fixture.bin"), Buffer.from([0, 255, 128]));
    symlinkSync(join(fileRoot, "fixture.bin"), join(fileRoot, "linked.bin"));
    await expect(
      readGmailFileFromChannel(channel, { path: "fixture.bin", maxBytes: 2 }),
    ).rejects.toThrow("maximum size");
    for (const path of ["../fixture.bin", "/etc/passwd", "linked.bin"]) {
      await expect(readGmailFileFromChannel(channel, { path, maxBytes: 64 })).rejects.toThrow();
    }
  });
});

describe("Gmail private byte staging", () => {
  for (const bytes of [
    Buffer.from([0, 255, 128]),
    Buffer.alloc(0),
    Buffer.alloc(9 * 1024 * 1024, 0xab),
  ]) {
    test(`stages and cleans ${bytes.length} exact bytes without returning transfer authority`, async () => {
      const calls: string[] = [];
      let staged: Uint8Array | undefined;
      const storage = {
        putObject: async (input: { body: Uint8Array }) => {
          calls.push("put");
          staged = input.body;
        },
        createGetUrl: async () => ({
          url: "https://storage.example.test/private?signature=synthetic",
          expiresAt: new Date(Date.now() + 60000),
        }),
        deleteObject: async () => {
          calls.push("delete");
        },
      } as unknown as ObjectStorage;
      const hash = createHash("sha256").update(bytes).digest("hex");
      const receipt = await materializeGmailFile(
        {
          serverId: "gmail",
          connectionId: "connection-test",
          operationId: "12345678-1234-4123-8123-123456789abc",
          providerAttachmentId: {
            provider: "google-gmail",
            kind: "attachment",
            value: "message:test:part:1",
          },
          fileName: "test.bin",
          mediaType: "application/octet-stream",
          bytes,
          authorizeProviderRequest: async () => true,
        },
        {
          workspaceId: "workspace-test",
          storage,
          downloadStorage: storage,
          materialize: async (request) => {
            calls.push("import");
            expect(await request.authorizeProviderRequest!()).toBe(true);
            expect(request.attachments[0]!.contentSha256).toBe(hash);
            return {
              version: 1,
              attachments: request.attachments.map(({ source: _source, ...attachment }) => ({
                ...attachment,
                sandboxPath: ".opengeni/connector-attachments/test.bin",
              })),
            };
          },
        },
      );
      expect(Buffer.from(staged!)).toEqual(bytes);
      expect(calls).toEqual(["put", "import", "delete"]);
      expect(JSON.stringify(receipt)).not.toContain("signature");
      expect(receipt.attachments[0]!.contentSha256).toBe(hash);
    });
  }
  test("cleans a staged object after import failure and refuses revoked authority before staging", async () => {
    let puts = 0,
      deletes = 0;
    const storage = {
      putObject: async () => {
        puts++;
      },
      createGetUrl: async () => ({
        url: "https://storage.example.test/private",
        expiresAt: new Date(Date.now() + 60000),
      }),
      deleteObject: async () => {
        deletes++;
      },
    } as unknown as ObjectStorage;
    const request = {
      serverId: "gmail",
      connectionId: "connection-test",
      operationId: "12345678-1234-4123-8123-123456789abc",
      providerAttachmentId: {
        provider: "google-gmail" as const,
        kind: "attachment" as const,
        value: "part-test",
      },
      fileName: "test.bin",
      mediaType: "application/octet-stream",
      bytes: Buffer.from([0, 255]),
      authorizeProviderRequest: async () => true,
    };
    const options = {
      workspaceId: "workspace-test",
      storage,
      downloadStorage: storage,
      materialize: async () => {
        throw new Error("filesystem offline");
      },
    };
    await expect(materializeGmailFile(request, options)).rejects.toThrow("filesystem offline");
    expect(puts).toBe(1);
    expect(deletes).toBe(1);
    await expect(
      materializeGmailFile({ ...request, authorizeProviderRequest: async () => false }, options),
    ).rejects.toThrow("authority");
    expect(puts).toBe(1);
  });

  test("cleanup failure preserves exact receipts and typed import uncertainty", async () => {
    let deleted = 0,
      reported = 0;
    const storage = {
      putObject: async () => {},
      createGetUrl: async () => ({
        url: "https://storage.example.test/private",
        expiresAt: new Date(Date.now() + 60000),
      }),
      deleteObject: async () => {
        deleted++;
        throw new Error("unavailable");
      },
    } as unknown as ObjectStorage;
    const request = {
      serverId: "gmail",
      connectionId: "connection-test",
      operationId: "12345678-1234-4123-8123-123456789abc",
      providerAttachmentId: {
        provider: "google-gmail" as const,
        kind: "attachment" as const,
        value: "test-part",
      },
      fileName: "test.bin",
      mediaType: "application/octet-stream",
      bytes: Buffer.alloc(0),
      authorizeProviderRequest: async () => true,
    };
    const receipt = { version: 1 as const, attachments: [] };
    const options = {
      workspaceId: "workspace-test",
      storage,
      downloadStorage: storage,
      materialize: async () => receipt,
      onCleanupFailure: () => {
        reported++;
      },
    };
    expect(await materializeGmailFile(request, options)).toEqual({ attachments: [] });
    expect(deleted).toBe(3);
    expect(reported).toBe(1);
    const uncertain = new RoutingMutationOutcomeUnknownError("fs.import", "unknown");
    await expect(
      materializeGmailFile(request, {
        ...options,
        materialize: async () => {
          throw uncertain;
        },
      }),
    ).rejects.toBe(uncertain);
    expect(deleted).toBe(6);
  });
});
