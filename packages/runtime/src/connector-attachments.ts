import {
  CONNECTOR_ATTACHMENT_RECEIPT_META_KEY,
  CONNECTOR_ATTACHMENT_RECEIPT_VERSION,
  CONNECTOR_ATTACHMENT_TRANSFER_META_KEY,
  ConnectorAttachmentReceiptEnvelope,
  parseConnectorAttachmentTransferEnvelope,
  type AttemptToolResult,
  type ConnectorAttachmentReceipt,
  type ConnectorAttachmentReceiptEnvelope as ConnectorAttachmentReceiptEnvelopeValue,
  type ConnectorAttachmentTransfer,
} from "@opengeni/contracts";
import { assertMcpPayloadWithinBytes } from "./mcp-network";

export const CONNECTOR_ATTACHMENT_SANITIZED_RESULT_MAX_BYTES = 128 * 1024;
export const CONNECTOR_ATTACHMENT_PROVIDER_RESULT_MAX_BYTES = 64 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ConnectorAttachmentMaterializationRequest = Readonly<{
  serverId: string;
  toolName: string;
  operationId: string;
  connectionId: string;
  attachments: readonly ConnectorAttachmentTransfer[];
}>;

export type ConnectorAttachmentMaterializer = (
  request: ConnectorAttachmentMaterializationRequest,
) => Promise<ConnectorAttachmentReceiptEnvelopeValue>;

export type ConnectorAttachmentTransferProjectionOptions = Readonly<{
  serverId: string;
  toolName: string;
  operationId: string | undefined;
  expectedProvider?: string;
  authorizeAndMaterialize: (
    attachments: readonly ConnectorAttachmentTransfer[],
  ) => Promise<ConnectorAttachmentReceiptEnvelopeValue>;
}>;

export class ConnectorAttachmentTransferError extends Error {
  constructor() {
    super("Connector attachment transfer was rejected");
    this.name = "ConnectorAttachmentTransferError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsPrivateSourceUrl(value: unknown, sourceUrls: readonly string[]): boolean {
  if (typeof value === "string") {
    return sourceUrls.some((sourceUrl) => value.includes(sourceUrl));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsPrivateSourceUrl(item, sourceUrls));
  }
  if (isRecord(value)) {
    return Object.values(value).some((item) => containsPrivateSourceUrl(item, sourceUrls));
  }
  return false;
}

function sameProviderIdentity(
  left: ConnectorAttachmentTransfer["providerAttachmentId"],
  right: ConnectorAttachmentReceipt["providerAttachmentId"],
): boolean {
  return left.provider === right.provider && left.kind === right.kind && left.value === right.value;
}

function assertReceiptsMatchTransfers(
  transfers: readonly ConnectorAttachmentTransfer[],
  receipts: readonly ConnectorAttachmentReceipt[],
): void {
  if (transfers.length !== receipts.length) throw new ConnectorAttachmentTransferError();
  for (const [index, transfer] of transfers.entries()) {
    const receipt = receipts[index];
    if (
      !receipt ||
      !sameProviderIdentity(transfer.providerAttachmentId, receipt.providerAttachmentId) ||
      transfer.fileName !== receipt.fileName ||
      transfer.mediaType !== receipt.mediaType ||
      transfer.byteSize !== receipt.byteSize ||
      transfer.contentSha256 !== receipt.contentSha256
    ) {
      throw new ConnectorAttachmentTransferError();
    }
  }
}

function receiptText(receipts: readonly ConnectorAttachmentReceipt[]): string {
  const paths = receipts.map((receipt) => `- ${JSON.stringify(receipt.sandboxPath)}`).join("\n");
  return `Connector attachments were materialized as exact sandbox files:\n${paths}`;
}

/**
 * Removes private transfer authority before an MCP result can reach model,
 * Codemode, custom-data, or durable event projections. The private callback
 * must complete exact-byte materialization before URL-free receipts are added.
 */
export async function projectConnectorAttachmentTransfers(
  output: unknown,
  options: ConnectorAttachmentTransferProjectionOptions,
): Promise<unknown> {
  if (!isRecord(output) || !isRecord(output._meta)) return output;
  if (!Object.hasOwn(output._meta, CONNECTOR_ATTACHMENT_TRANSFER_META_KEY)) return output;

  try {
    const privateTransfer = output._meta[CONNECTOR_ATTACHMENT_TRANSFER_META_KEY];
    const sanitizedMeta = { ...output._meta };
    delete sanitizedMeta[CONNECTOR_ATTACHMENT_TRANSFER_META_KEY];
    const sanitizedOutput: Record<string, unknown> = { ...output, _meta: sanitizedMeta };
    const envelope = parseConnectorAttachmentTransferEnvelope(privateTransfer);
    if (!options.operationId || !UUID_PATTERN.test(options.operationId)) {
      throw new ConnectorAttachmentTransferError();
    }
    if (
      options.expectedProvider &&
      envelope.attachments.some(
        (attachment) => attachment.providerAttachmentId.provider !== options.expectedProvider,
      )
    ) {
      throw new ConnectorAttachmentTransferError();
    }
    const content: unknown[] = Array.isArray(sanitizedOutput.content)
      ? sanitizedOutput.content
      : [];
    if (
      content.some(
        (item) => !isRecord(item) || item.type !== "text" || typeof item.text !== "string",
      )
    ) {
      throw new ConnectorAttachmentTransferError();
    }
    if (sanitizedOutput.structuredContent !== undefined || sanitizedOutput.isError === true) {
      throw new ConnectorAttachmentTransferError();
    }
    assertMcpPayloadWithinBytes(
      sanitizedOutput,
      CONNECTOR_ATTACHMENT_PROVIDER_RESULT_MAX_BYTES,
      "connector attachment provider result",
    );
    const sourceUrls = envelope.attachments.map((attachment) => attachment.source.url);
    if (containsPrivateSourceUrl(sanitizedOutput, sourceUrls)) {
      throw new ConnectorAttachmentTransferError();
    }

    const receiptEnvelope = ConnectorAttachmentReceiptEnvelope.parse(
      await options.authorizeAndMaterialize(envelope.attachments),
    );
    assertReceiptsMatchTransfers(envelope.attachments, receiptEnvelope.attachments);
    const projected: AttemptToolResult = {
      content: [{ type: "text", text: receiptText(receiptEnvelope.attachments) }],
      _meta: {
        [CONNECTOR_ATTACHMENT_RECEIPT_META_KEY]: {
          version: CONNECTOR_ATTACHMENT_RECEIPT_VERSION,
          attachments: receiptEnvelope.attachments,
        },
      },
    } as AttemptToolResult;
    assertMcpPayloadWithinBytes(
      projected,
      CONNECTOR_ATTACHMENT_SANITIZED_RESULT_MAX_BYTES,
      "sanitized connector attachment result",
    );
    return projected;
  } catch {
    throw new ConnectorAttachmentTransferError();
  }
}
