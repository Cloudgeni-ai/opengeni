import { createHash } from "node:crypto";
import type { ObjectStorage } from "@opengeni/storage";
import type { GmailFileMaterializationRequest } from "@opengeni/runtime/gmail-rest-mcp";
import type { ConnectorAttachmentMaterializer } from "@opengeni/runtime";
import type { SandboxChannelAService } from "@opengeni/runtime/sandbox";

/** Use the selected filesystem namespace, retaining descriptor confinement and
 * one extra byte to distinguish a complete exact-limit input from truncation. */
export async function readGmailFileFromChannel(
  channel: Pick<SandboxChannelAService, "fsRead">,
  request: { path: string; maxBytes: number },
): Promise<Uint8Array> {
  const file = await channel.fsRead({
    path: request.path,
    maxBytes: request.maxBytes + 1,
    encoding: "base64",
    workspaceOnly: true,
  });
  const bytes = Buffer.from(file.content, "base64");
  if (file.truncated || bytes.byteLength > request.maxBytes)
    throw new Error("Gmail file input exceeds the maximum size");
  return bytes;
}

/** Gmail returns base64url JSON, while the exact filesystem importer consumes
 * byte streams. Stage only inside the worker; no URL or bytes reach a tool result. */
export async function materializeGmailFile(
  request: GmailFileMaterializationRequest,
  options: {
    workspaceId: string;
    storage: ObjectStorage;
    downloadStorage: ObjectStorage;
    materialize: ConnectorAttachmentMaterializer;
    onCleanupFailure?: (key: string) => void;
  },
) {
  if (!(await request.authorizeProviderRequest()))
    throw new Error("Gmail file authority is unavailable");
  const hash = createHash("sha256").update(request.bytes).digest("hex");
  const key = `workspaces/${options.workspaceId}/private-connector-transfers/${crypto.randomUUID()}`;
  try {
    await options.storage.putObject({
      key,
      body: request.bytes,
      contentType: request.mediaType,
      sha256: hash,
    });
    const source = await options.downloadStorage.createGetUrl({ key, expiresInSeconds: 300 });
    const envelope = await options.materialize({
      serverId: request.serverId,
      toolName: request.providerAttachmentId.value.endsWith(":raw")
        ? "download_message"
        : "download_attachment",
      operationId: request.operationId,
      connectionId: request.connectionId,
      authorizeProviderRequest: request.authorizeProviderRequest,
      attachments: [
        {
          providerAttachmentId: request.providerAttachmentId,
          fileName: request.fileName,
          mediaType: request.mediaType,
          byteSize: request.bytes.byteLength,
          contentSha256: hash,
          source: { url: source.url, expiresAt: source.expiresAt.toISOString() },
        },
      ],
    });
    return { attachments: envelope.attachments };
  } finally {
    // The transfer object is never a retained workspace File or Knowledge entry.
    let cleaned = false;
    for (let attempt = 0; attempt < 3 && !cleaned; attempt++) {
      try {
        await options.storage.deleteObject(key);
        cleaned = true;
      } catch {
        /* Idempotent storage cleanup must not erase delivery or uncertainty. */
      }
    }
    if (!cleaned) {
      try {
        options.onCleanupFailure?.(key);
      } catch {
        /* Observability cannot replace a file result. */
      }
    }
  }
}
