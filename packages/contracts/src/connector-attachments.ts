import { z } from "zod";

export const CONNECTOR_ATTACHMENT_TRANSFER_VERSION = 1 as const;
export const CONNECTOR_ATTACHMENT_RECEIPT_VERSION = 1 as const;
export const CONNECTOR_ATTACHMENT_TRANSFER_META_KEY =
  "opengeni/connector-attachment-transfers" as const;
export const CONNECTOR_ATTACHMENT_RECEIPT_META_KEY =
  "opengeni/connector-attachment-receipts" as const;
export const CONNECTOR_ATTACHMENT_MAX_COUNT = 16;
// Must remain byte-for-byte aligned with Channel A's exact workspace importer.
export const CONNECTOR_ATTACHMENT_MAX_BYTES = 5_000_000_000;
export const CONNECTOR_ATTACHMENT_FILENAME_MAX_UTF8_BYTES = 255;
export const CONNECTOR_ATTACHMENT_MEDIA_TYPE_MAX_UTF8_BYTES = 256;
export const CONNECTOR_ATTACHMENT_PROVIDER_MAX_UTF8_BYTES = 128;
export const CONNECTOR_ATTACHMENT_PROVIDER_ID_MAX_UTF8_BYTES = 512;
export const CONNECTOR_ATTACHMENT_SOURCE_URL_MAX_UTF8_BYTES = 8 * 1024;
export const CONNECTOR_ATTACHMENT_SANDBOX_PATH_MAX_UTF8_BYTES = 2 * 1024;

const PROVIDER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const HTTP_URL_REFERENCE_PATTERN = /(?:https?:)?\/\/[^\s]/iu;
const PORTABLE_FILENAME_FORBIDDEN_PATTERN = /[<>:"|?*]/u;
const PORTABLE_FILENAME_RESERVED_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const textEncoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function boundedString(maxUtf8Bytes: number) {
  return z.string().refine((value) => utf8Bytes(value) <= maxUtf8Bytes, {
    message: `must be at most ${maxUtf8Bytes} UTF-8 bytes`,
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function containsHttpUrlReference(value: string): boolean {
  return HTTP_URL_REFERENCE_PATTERN.test(value);
}

function isPrivateUrlCredentialQueryName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    normalized === "sig" ||
    normalized === "auth" ||
    normalized.endsWith("signature") ||
    normalized.endsWith("token") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passcode") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("securitytoken") ||
    normalized.endsWith("sas") ||
    normalized === "googleaccessid"
  );
}

function privateUrlCredentialValues(value: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [];
  }
  const credentials = new Set<string>();
  for (const [name, credential] of parsed.searchParams) {
    if (credential && isPrivateUrlCredentialQueryName(name)) credentials.add(credential);
  }
  for (const pair of parsed.search.slice(1).split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawCredential = separator === -1 ? "" : pair.slice(separator + 1);
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(rawName.replace(/\+/gu, " "));
    } catch {
      continue;
    }
    if (rawCredential && isPrivateUrlCredentialQueryName(decodedName)) {
      credentials.add(rawCredential);
    }
  }
  return [...credentials];
}

function publicMetadataContainsCredential(publicValue: string, credential: string): boolean {
  return publicValue.includes(credential);
}

export const ConnectorAttachmentProviderIdentity = z
  .object({
    provider: boundedString(CONNECTOR_ATTACHMENT_PROVIDER_MAX_UTF8_BYTES).regex(PROVIDER_PATTERN),
    kind: z.literal("attachment"),
    value: boundedString(CONNECTOR_ATTACHMENT_PROVIDER_ID_MAX_UTF8_BYTES)
      .min(1)
      .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
        message: "must not contain control characters",
      })
      .refine((value) => !isHttpUrl(value) && !containsHttpUrlReference(value), {
        message: "must be an opaque provider attachment identity, not a URL",
      }),
  })
  .strict();
export type ConnectorAttachmentProviderIdentity = z.infer<
  typeof ConnectorAttachmentProviderIdentity
>;

export const ConnectorAttachmentFileName = boundedString(
  CONNECTOR_ATTACHMENT_FILENAME_MAX_UTF8_BYTES,
)
  .min(1)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      value === value.trim() &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !CONTROL_CHARACTER_PATTERN.test(value) &&
      !PORTABLE_FILENAME_FORBIDDEN_PATTERN.test(value) &&
      !/[ .]$/u.test(value) &&
      !PORTABLE_FILENAME_RESERVED_PATTERN.test(value),
    { message: "must be a safe leaf filename" },
  );

export const ConnectorAttachmentMediaType = boundedString(
  CONNECTOR_ATTACHMENT_MEDIA_TYPE_MAX_UTF8_BYTES,
)
  .regex(MEDIA_TYPE_PATTERN)
  .refine((value) => !containsHttpUrlReference(value), {
    message: "must not contain an HTTP URL reference",
  });

export const ConnectorAttachmentSha256 = z.string().regex(SHA256_PATTERN);

export const ConnectorAttachmentPrivateSource = z
  .object({
    url: boundedString(CONNECTOR_ATTACHMENT_SOURCE_URL_MAX_UTF8_BYTES).superRefine(
      (value, context) => {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          context.addIssue({
            code: "custom",
            message: "must be an absolute URL",
          });
          return;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          context.addIssue({ code: "custom", message: "must use http or https" });
        }
        if (parsed.username || parsed.password) {
          context.addIssue({
            code: "custom",
            message: "must not contain URL userinfo",
          });
        }
        if (parsed.hash) {
          context.addIssue({
            code: "custom",
            message: "must not contain a URL fragment",
          });
        }
      },
    ),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ConnectorAttachmentPrivateSource = z.infer<typeof ConnectorAttachmentPrivateSource>;

export const ConnectorAttachmentTransfer = z
  .object({
    providerAttachmentId: ConnectorAttachmentProviderIdentity,
    fileName: ConnectorAttachmentFileName,
    mediaType: ConnectorAttachmentMediaType,
    byteSize: z.number().int().min(0).max(CONNECTOR_ATTACHMENT_MAX_BYTES),
    contentSha256: ConnectorAttachmentSha256,
    source: ConnectorAttachmentPrivateSource,
  })
  .strict()
  .superRefine((attachment, context) => {
    const publicValues = [
      attachment.providerAttachmentId.value,
      attachment.fileName,
      attachment.mediaType,
    ];
    for (const credential of privateUrlCredentialValues(attachment.source.url)) {
      if (publicValues.some((value) => publicMetadataContainsCredential(value, credential))) {
        context.addIssue({
          code: "custom",
          message: "private source credentials must not appear in public attachment metadata",
        });
        return;
      }
    }
  });
export type ConnectorAttachmentTransfer = z.infer<typeof ConnectorAttachmentTransfer>;

export const ConnectorAttachmentTransferEnvelope = z
  .object({
    version: z.literal(CONNECTOR_ATTACHMENT_TRANSFER_VERSION),
    attachments: z.array(ConnectorAttachmentTransfer).min(1).max(CONNECTOR_ATTACHMENT_MAX_COUNT),
  })
  .strict()
  .superRefine((envelope, context) => {
    const identities = new Set<string>();
    for (const [index, attachment] of envelope.attachments.entries()) {
      const identity = `${attachment.providerAttachmentId.provider}\0${attachment.providerAttachmentId.value}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "provider attachment identities must be unique",
          path: ["attachments", index, "providerAttachmentId"],
        });
      }
      identities.add(identity);
    }
  });
export type ConnectorAttachmentTransferEnvelope = z.infer<
  typeof ConnectorAttachmentTransferEnvelope
>;

export const ConnectorAttachmentSandboxPath = boundedString(
  CONNECTOR_ATTACHMENT_SANDBOX_PATH_MAX_UTF8_BYTES,
)
  .min(1)
  .refine(
    (value) => {
      if (
        value !== value.trim() ||
        value.startsWith("/") ||
        /^[A-Za-z]:[\\/]/u.test(value) ||
        value.includes("\\") ||
        CONTROL_CHARACTER_PATTERN.test(value)
      ) {
        return false;
      }
      const segments = value.split("/");
      if (
        segments.length !== 5 ||
        segments[0] !== ".opengeni" ||
        segments[1] !== "connector-attachments" ||
        !PROVIDER_PATTERN.test(segments[2] ?? "") ||
        !/^[0-9a-f]{32}$/u.test(segments[3] ?? "") ||
        !ConnectorAttachmentFileName.safeParse(segments[4]).success
      ) {
        return false;
      }
      return segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !PORTABLE_FILENAME_FORBIDDEN_PATTERN.test(segment) &&
          !/[ .]$/u.test(segment) &&
          !PORTABLE_FILENAME_RESERVED_PATTERN.test(segment),
      );
    },
    { message: "must be a confined connector attachment sandbox path" },
  );

export const ConnectorAttachmentReceipt = z
  .object({
    providerAttachmentId: ConnectorAttachmentProviderIdentity,
    fileName: ConnectorAttachmentFileName,
    mediaType: ConnectorAttachmentMediaType,
    byteSize: z.number().int().min(0).max(CONNECTOR_ATTACHMENT_MAX_BYTES),
    contentSha256: ConnectorAttachmentSha256,
    sandboxPath: ConnectorAttachmentSandboxPath,
  })
  .strict()
  .superRefine((receipt, context) => {
    const segments = receipt.sandboxPath.split("/");
    if (segments[2] !== receipt.providerAttachmentId.provider) {
      context.addIssue({
        code: "custom",
        message: "sandbox path provider must match the provider attachment identity",
        path: ["sandboxPath"],
      });
    }
    if (segments[4] !== receipt.fileName) {
      context.addIssue({
        code: "custom",
        message: "sandbox path filename must match the attachment filename",
        path: ["sandboxPath"],
      });
    }
  });
export type ConnectorAttachmentReceipt = z.infer<typeof ConnectorAttachmentReceipt>;

export const ConnectorAttachmentReceiptEnvelope = z
  .object({
    version: z.literal(CONNECTOR_ATTACHMENT_RECEIPT_VERSION),
    attachments: z.array(ConnectorAttachmentReceipt).min(1).max(CONNECTOR_ATTACHMENT_MAX_COUNT),
  })
  .strict();
export type ConnectorAttachmentReceiptEnvelope = z.infer<typeof ConnectorAttachmentReceiptEnvelope>;

export function parseConnectorAttachmentTransferEnvelope(
  value: unknown,
  options: { nowMs?: number } = {},
): ConnectorAttachmentTransferEnvelope {
  const envelope = ConnectorAttachmentTransferEnvelope.parse(value);
  const nowMs = options.nowMs ?? Date.now();
  for (const attachment of envelope.attachments) {
    if (Date.parse(attachment.source.expiresAt) <= nowMs) {
      throw new Error("connector attachment source is expired");
    }
  }
  return envelope;
}
