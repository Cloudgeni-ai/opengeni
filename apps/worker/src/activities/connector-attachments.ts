import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import {
  CONNECTOR_ATTACHMENT_RECEIPT_VERSION,
  ConnectorAttachmentReceiptEnvelope,
  type ConnectorAttachmentReceiptEnvelope as ConnectorAttachmentReceiptEnvelopeValue,
  type ConnectorAttachmentTransfer,
} from "@opengeni/contracts";
import type { ConnectorAttachmentMaterializationRequest } from "@opengeni/runtime";
import { SandboxChannelAService } from "@opengeni/runtime/sandbox";

export class ConnectorAttachmentMaterializationError extends Error {
  constructor() {
    super("Connector attachment could not be materialized in the sandbox");
    this.name = "ConnectorAttachmentMaterializationError";
  }
}

type ConnectorAttachmentChannel = Pick<SandboxChannelAService, "fsMkdir" | "importWorkspaceFile">;

function digestParts(...parts: readonly string[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest();
}

function uuidFromDigest(digest: Buffer): string {
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function connectorAttachmentSandboxPath(
  request: Pick<ConnectorAttachmentMaterializationRequest, "serverId" | "connectionId">,
  attachment: ConnectorAttachmentTransfer,
): string {
  const digest = digestParts(
    "opengeni-connector-attachment-path-v1",
    request.serverId,
    request.connectionId,
    attachment.providerAttachmentId.provider,
    attachment.providerAttachmentId.value,
    attachment.contentSha256,
  )
    .toString("hex")
    .slice(0, 32);
  return posixPath.join(
    ".opengeni/connector-attachments",
    attachment.providerAttachmentId.provider,
    digest,
    attachment.fileName,
  );
}

export function connectorAttachmentImportOperationId(
  request: Pick<
    ConnectorAttachmentMaterializationRequest,
    "serverId" | "toolName" | "operationId" | "connectionId"
  >,
  attachment: ConnectorAttachmentTransfer,
  index: number,
): string {
  return uuidFromDigest(
    digestParts(
      "opengeni-connector-attachment-import-v1",
      request.serverId,
      request.toolName,
      request.operationId,
      request.connectionId,
      String(index),
      attachment.providerAttachmentId.provider,
      attachment.providerAttachmentId.value,
      attachment.contentSha256,
    ),
  );
}

export async function materializeConnectorAttachmentsInChannel(
  channel: ConnectorAttachmentChannel,
  request: ConnectorAttachmentMaterializationRequest,
): Promise<ConnectorAttachmentReceiptEnvelopeValue> {
  try {
    const receipts = [];
    for (const [index, attachment] of request.attachments.entries()) {
      const sandboxPath = connectorAttachmentSandboxPath(request, attachment);
      await channel.fsMkdir({ path: posixPath.dirname(sandboxPath), recursive: true });
      const imported = await channel.importWorkspaceFile({
        operationId: connectorAttachmentImportOperationId(request, attachment, index),
        destinationPath: sandboxPath,
        overwrite: false,
        mayReplaceExisting: false,
        sizeBytes: attachment.byteSize,
        sha256: attachment.contentSha256,
        source: attachment.source,
      });
      if (
        imported.destinationPath !== sandboxPath ||
        imported.sizeBytes !== attachment.byteSize ||
        imported.sha256 !== attachment.contentSha256
      ) {
        throw new ConnectorAttachmentMaterializationError();
      }
      receipts.push({
        providerAttachmentId: attachment.providerAttachmentId,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        byteSize: attachment.byteSize,
        contentSha256: attachment.contentSha256,
        sandboxPath,
      });
    }
    return ConnectorAttachmentReceiptEnvelope.parse({
      version: CONNECTOR_ATTACHMENT_RECEIPT_VERSION,
      attachments: receipts,
    });
  } catch {
    throw new ConnectorAttachmentMaterializationError();
  }
}
