import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_ATTACHMENT_MAX_BYTES,
  CONNECTOR_ATTACHMENT_MAX_COUNT,
  CONNECTOR_ATTACHMENT_RECEIPT_META_KEY,
  CONNECTOR_ATTACHMENT_TRANSFER_META_KEY,
  ConnectorAttachmentReceiptEnvelope,
  ConnectorAttachmentTransferEnvelope,
  parseConnectorAttachmentTransferEnvelope,
} from "../src";

const future = "2030-01-02T03:04:05.000Z";
const baseAttachment = {
  providerAttachmentId: {
    provider: "example.connector",
    kind: "attachment" as const,
    value: "provider-file-123",
  },
  fileName: "report.txt",
  mediaType: "text/plain; charset=utf-8",
  byteSize: 12,
  contentSha256: "a".repeat(64),
  source: {
    url: "https://files.example.test/download?id=123&signature=private",
    expiresAt: future,
  },
};

describe("connector attachment transfer contract", () => {
  test("uses distinct private transfer and public receipt metadata keys", () => {
    expect(CONNECTOR_ATTACHMENT_TRANSFER_META_KEY).not.toBe(CONNECTOR_ATTACHMENT_RECEIPT_META_KEY);
  });

  test.each([
    ["binary", "payload.bin", "application/octet-stream", 6],
    ["UTF-8", "notes.txt", "text/plain; charset=utf-8", 18],
    ["image", "pixel.png", "image/png", 68],
    ["PDF", "document.pdf", "application/pdf", 145],
    ["patch", "change.patch", "text/x-diff", 31],
    ["empty", "empty.dat", "application/octet-stream", 0],
    ["large", "archive.bin", "application/octet-stream", CONNECTOR_ATTACHMENT_MAX_BYTES],
  ])("accepts exact %s attachment metadata", (_kind, fileName, mediaType, byteSize) => {
    const envelope = ConnectorAttachmentTransferEnvelope.parse({
      version: 1,
      attachments: [{ ...baseAttachment, fileName, mediaType, byteSize }],
    });
    expect(envelope.attachments[0]).toMatchObject({
      fileName,
      mediaType,
      byteSize,
    });
  });

  test("accepts existing lowercase provider namespaces with underscores", () => {
    const envelope = ConnectorAttachmentTransferEnvelope.parse({
      version: 1,
      attachments: [
        {
          ...baseAttachment,
          providerAttachmentId: {
            ...baseAttachment.providerAttachmentId,
            provider: "google_drive",
          },
        },
      ],
    });
    expect(envelope.attachments[0]?.providerAttachmentId.provider).toBe("google_drive");
  });

  test("rejects expired sources at the authority boundary", () => {
    expect(() =>
      parseConnectorAttachmentTransferEnvelope(
        { version: 1, attachments: [baseAttachment] },
        { nowMs: Date.parse(future) },
      ),
    ).toThrow("expired");
  });

  test.each([
    [
      "provider identity",
      {
        providerAttachmentId: {
          ...baseAttachment.providerAttachmentId,
          value: "provider-file-SIGNED_TOKEN_9f1d",
        },
      },
    ],
    ["filename", { fileName: "SIGNED_TOKEN_9f1d.bin" }],
    ["media type", { mediaType: 'application/octet-stream; token="SIGNED_TOKEN_9f1d"' }],
  ])("rejects private source credentials copied into public %s", (_label, override) => {
    expect(() =>
      ConnectorAttachmentTransferEnvelope.parse({
        version: 1,
        attachments: [
          {
            ...baseAttachment,
            ...override,
            source: {
              ...baseAttachment.source,
              url: "https://files.example.test/download?signature=SIGNED_TOKEN_9f1d",
            },
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects short private source credentials embedded in public metadata", () => {
    expect(() =>
      ConnectorAttachmentTransferEnvelope.parse({
        version: 1,
        attachments: [
          {
            ...baseAttachment,
            providerAttachmentId: {
              ...baseAttachment.providerAttachmentId,
              value: "provider-file-abc",
            },
            source: {
              ...baseAttachment.source,
              url: "https://files.example.test/download?sig=abc",
            },
          },
        ],
      }),
    ).toThrow();
  });

  test.each([
    ["path separator", { fileName: "folder/report.txt" }],
    ["backslash", { fileName: "folder\\report.txt" }],
    ["dot segment", { fileName: ".." }],
    ["Channel A forbidden filename character", { fileName: "report: Q1.pdf" }],
    ["Channel A reserved filename", { fileName: "CON.txt" }],
    ["invalid media type", { mediaType: "plain text" }],
    [
      "URL-bearing media type parameter",
      {
        mediaType:
          'application/octet-stream; source="https://files.example.test/private?signature=value"',
      },
    ],
    ["uppercase digest", { contentSha256: "A".repeat(64) }],
    [
      "URL-shaped provider identity",
      {
        providerAttachmentId: {
          ...baseAttachment.providerAttachmentId,
          value: "https://files.example.test/private?id=42",
        },
      },
    ],
    [
      "whitespace-prefixed URL-shaped provider identity",
      {
        providerAttachmentId: {
          ...baseAttachment.providerAttachmentId,
          value: "  https://files.example.test/private?id=42",
        },
      },
    ],
    [
      "protocol-relative URL-shaped provider identity",
      {
        providerAttachmentId: {
          ...baseAttachment.providerAttachmentId,
          value: "//files.example.test/private?signature=value",
        },
      },
    ],
    ["oversized payload", { byteSize: CONNECTOR_ATTACHMENT_MAX_BYTES + 1 }],
    ["non-http source", { source: { ...baseAttachment.source, url: "file:///tmp/a" } }],
    [
      "credential-bearing source",
      {
        source: {
          ...baseAttachment.source,
          url: "https://user:secret@example.test/file",
        },
      },
    ],
    [
      "fragment-bearing source",
      {
        source: {
          ...baseAttachment.source,
          url: "https://example.test/file#secret",
        },
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      ConnectorAttachmentTransferEnvelope.parse({
        version: 1,
        attachments: [{ ...baseAttachment, ...override }],
      }),
    ).toThrow();
  });

  test("rejects unbounded attachment counts and unknown fields", () => {
    expect(() =>
      ConnectorAttachmentTransferEnvelope.parse({
        version: 1,
        attachments: Array.from({ length: CONNECTOR_ATTACHMENT_MAX_COUNT + 1 }, () =>
          structuredClone(baseAttachment),
        ),
      }),
    ).toThrow();
    expect(() =>
      ConnectorAttachmentTransferEnvelope.parse({
        version: 1,
        attachments: [{ ...baseAttachment, rawBytes: "opaque" }],
      }),
    ).toThrow();
    expect(() =>
      ConnectorAttachmentTransferEnvelope.parse({
        version: 1,
        attachments: [baseAttachment, structuredClone(baseAttachment)],
      }),
    ).toThrow("unique");
  });

  test("accepts only URL-free confined receipts", () => {
    const receipt = ConnectorAttachmentReceiptEnvelope.parse({
      version: 1,
      attachments: [
        {
          providerAttachmentId: baseAttachment.providerAttachmentId,
          fileName: baseAttachment.fileName,
          mediaType: baseAttachment.mediaType,
          byteSize: baseAttachment.byteSize,
          contentSha256: baseAttachment.contentSha256,
          sandboxPath:
            ".opengeni/connector-attachments/example.connector/0123456789abcdef/report.txt",
        },
      ],
    });
    expect(JSON.stringify(receipt)).not.toContain("signature=private");
    expect(() =>
      ConnectorAttachmentReceiptEnvelope.parse({
        ...receipt,
        attachments: [{ ...receipt.attachments[0], source: baseAttachment.source }],
      }),
    ).toThrow();
    expect(() =>
      ConnectorAttachmentReceiptEnvelope.parse({
        ...receipt,
        attachments: [{ ...receipt.attachments[0], sandboxPath: "../report.txt" }],
      }),
    ).toThrow();
  });
});
