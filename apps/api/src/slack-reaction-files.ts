import { createHash } from "node:crypto";
import type { FileResourceRef } from "@opengeni/contracts";
import { completeFileUpload, prepareGeneratedWorkspaceFile, type Database } from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import type { DownloadedSlackReactionImage } from "./integrations/slack-bot";

const IMPORT_IDENTITY_VERSION = "slack-reaction-image-v1";
const UPLOAD_INTENT_TTL_MS = 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type SlackReactionImageImportSource = Readonly<{
  accountId: string;
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  slackChannelId: string;
  slackMessageTs: string;
}>;

export type ImportedSlackReactionImage = Readonly<{
  resource: FileResourceRef;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
}>;

export async function importSlackReactionImage(
  dependencies: Readonly<{
    db: Database;
    objectStorage: ObjectStorage;
    now?: () => Date;
    prepareFile?: typeof prepareGeneratedWorkspaceFile;
    completeFile?: typeof completeFileUpload;
  }>,
  source: SlackReactionImageImportSource,
  image: DownloadedSlackReactionImage,
  ordinal: number,
): Promise<ImportedSlackReactionImage> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 4) {
    throw new RangeError("Slack reaction attachment ordinal is invalid");
  }
  const storage = dependencies.objectStorage;
  if (!storage.headObject) {
    throw new Error("Object storage lacks immutable object verification support");
  }
  if (image.bytes.byteLength < 1 || image.bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("Slack reaction image size is invalid");
  }
  const sha256 = createHash("sha256").update(image.bytes).digest("hex");
  const identity = slackReactionImageIdentity(source, image.fileId);
  const fileId = deterministicUuid(`${identity}:file`);
  const uploadId = deterministicUuid(`${identity}:upload`);
  const safeFilename = safeSlackImageFilename(image.filename, image.contentType);
  const objectKey = `workspaces/${source.workspaceId}/files/${fileId}/slack-reactions/${safeFilename}`;
  const filename = safeFilename;
  const prepared = await (dependencies.prepareFile ?? prepareGeneratedWorkspaceFile)(
    dependencies.db,
    {
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      fileId,
      uploadId,
      filename,
      safeFilename,
      contentType: image.contentType,
      sizeBytes: image.bytes.byteLength,
      sha256,
      bucket: storage.bucket,
      objectKey,
      expiresAt: new Date((dependencies.now?.() ?? new Date()).getTime() + UPLOAD_INTENT_TTL_MS),
    },
  );

  let file = prepared.file;
  if (file.status !== "ready") {
    const existing = await storage.headObject(objectKey);
    if (existing) {
      assertStoredSlackImage(existing, image, sha256);
    } else if (storage.putObjectIfAbsent) {
      await storage.putObjectIfAbsent({
        key: objectKey,
        contentType: image.contentType,
        body: image.bytes,
        sha256,
      });
      assertStoredSlackImage(await storage.headObject(objectKey), image, sha256);
    } else {
      await storage.putObject({
        key: objectKey,
        contentType: image.contentType,
        body: image.bytes,
        sha256,
      });
      assertStoredSlackImage(await storage.headObject(objectKey), image, sha256);
    }
    file = await (dependencies.completeFile ?? completeFileUpload)(
      dependencies.db,
      source.workspaceId,
      uploadId,
    );
  } else {
    assertStoredSlackImage(await storage.headObject(objectKey), image, sha256);
  }

  if (
    file.id !== fileId ||
    file.status !== "ready" ||
    file.filename !== filename ||
    file.safeFilename !== safeFilename ||
    file.contentType !== image.contentType ||
    file.sizeBytes !== image.bytes.byteLength ||
    file.sha256 !== sha256
  ) {
    throw new Error("Imported Slack image differs from its immutable workspace file");
  }
  const mountPath = `attachments/slack/${String(ordinal).padStart(2, "0")}-${safeFilename}`;
  return Object.freeze({
    resource: Object.freeze({ kind: "file", fileId, mountPath }),
    filename,
    contentType: image.contentType,
    sizeBytes: image.bytes.byteLength,
  });
}

export function slackReactionImageIdentity(
  source: SlackReactionImageImportSource,
  slackFileId: string,
): string {
  return [
    IMPORT_IDENTITY_VERSION,
    source.workspaceId,
    source.connectionId,
    source.slackTeamId,
    source.slackChannelId,
    source.slackMessageTs,
    slackFileId,
  ].join(":");
}

export function safeSlackImageFilename(
  value: string,
  contentType: "image/png" | "image/jpeg" | "image/webp",
): string {
  const extension =
    contentType === "image/png" ? ".png" : contentType === "image/jpeg" ? ".jpg" : ".webp";
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
  const withoutKnownExtension = normalized.replace(/\.(?:png|jpe?g|webp)$/iu, "");
  const stem = withoutKnownExtension.replace(/^[. -]+|[. ]+$/gu, "").slice(0, 180) || "slack-image";
  return `${stem}${extension}`;
}

function assertStoredSlackImage(
  head: ObjectHead | null,
  image: DownloadedSlackReactionImage,
  sha256: string,
): void {
  if (
    !head ||
    head.ContentLength !== image.bytes.byteLength ||
    head.ContentType !== image.contentType ||
    head.Metadata?.sha256 !== sha256 ||
    typeof head.VersionToken !== "string" ||
    head.VersionToken.length < 1
  ) {
    throw new Error("Stored Slack image differs from its immutable import");
  }
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(value)) throw new Error("Slack reaction file identity is invalid");
  return value;
}
