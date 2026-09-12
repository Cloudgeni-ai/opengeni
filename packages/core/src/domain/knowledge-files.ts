import { createHash } from "node:crypto";
import {
  completeKnowledgeFilePreparation,
  inspectKnowledgeFilePreparation,
  type KnowledgeContext,
} from "@opengeni/db";
import { retryWhileMissing } from "@opengeni/storage";
import type { ApiRouteDeps } from "../dependencies";

/** Existing original -> one source revision, through the ordinary task policy. */
export async function prepareKnowledgeFile(
  deps: Pick<ApiRouteDeps, "db" | "objectStorage" | "getDocumentServices">,
  context: KnowledgeContext,
  fileId: string,
) {
  const inspected = await inspectKnowledgeFilePreparation(deps.db, context, fileId);
  if (inspected.status !== "prepare") return inspected;
  if (!deps.objectStorage) throw new Error("File storage is unavailable");
  const object = await retryWhileMissing(() =>
    deps.objectStorage!.getObjectBytes(inspected.file.objectKey),
  );
  if (!object) throw new Error("The original file is unavailable");
  const sourceVersion = createHash("sha256").update(object.bytes).digest("hex");
  if (
    object.bytes.byteLength !== inspected.file.sizeBytes ||
    (inspected.file.sha256 && inspected.file.sha256.toLowerCase() !== sourceVersion)
  ) {
    throw new Error("The original file no longer matches its retained metadata");
  }
  const parsed = await deps.getDocumentServices().parser.parse(object.bytes, inspected.file);
  // Empty extraction is a visible failure, not a searchable-ready receipt.
  if (!parsed.text.trim()) throw new Error("No searchable text could be extracted from this file");
  return completeKnowledgeFilePreparation(deps.db, context, {
    fileId,
    title: inspected.file.filename,
    sourceVersion,
    content: parsed.text,
  });
}
