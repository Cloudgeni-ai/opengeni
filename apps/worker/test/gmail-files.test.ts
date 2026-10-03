import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ObjectStorage } from "@opengeni/storage";
import { materializeGmailFile } from "../src/activities/gmail-files";
import { RoutingMutationOutcomeUnknownError } from "@opengeni/runtime/sandbox";

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
