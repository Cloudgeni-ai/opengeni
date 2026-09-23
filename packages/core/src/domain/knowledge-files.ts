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
  purpose: "evidence" | "reference" = "evidence",
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
  // A screenshot/diagram can support a visual finding without containing text.
  // Keep its exact original; OCR is neither required evidence nor the finding.
  const originalOnly = purpose === "evidence" && inspected.file.contentType.startsWith("image/");
  const parsed = originalOnly
    ? { text: "" }
    : await deps.getDocumentServices().parser.parse(object.bytes, inspected.file);
  if (!originalOnly && !parsed.text.trim())
    throw new Error("No searchable text could be extracted from this file");
  return completeKnowledgeFilePreparation(deps.db, context, {
    fileId,
    title: inspected.file.filename,
    sourceVersion,
    content: parsed.text,
    purpose,
  });
}
