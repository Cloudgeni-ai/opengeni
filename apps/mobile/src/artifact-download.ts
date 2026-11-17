import type {
  ArtifactCatalogItem,
  ChatClient,
  OpenGeniClient,
  RetainedArtifactReference,
} from "@opengeni/sdk";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Alert, Platform, Share } from "react-native";
import { newReplicaId } from "@/artifact-library";
import { downloadFormat } from "@/artifacts";

/*
 * Download in the original format: a Site's page as HTML, an image or file as
 * itself, a spreadsheet as XLSX (the web's exporter). iOS offers the share
 * sheet (Save to Files and the rest); Android asks for a folder to save into.
 */

export type DownloadClient = Pick<
  ChatClient<OpenGeniClient>,
  | "getWorkspaceArtifactHtml"
  | "createRetainedArtifactDownloadUrl"
  | "getEditableArtifact"
  | "pinEditableArtifactVersion"
  | "createEditableArtifactMaterialization"
  | "getEditableArtifactMaterialization"
  | "downloadEditableArtifactMaterialization"
>;

const EXPORT_DEADLINE_MS = 120_000;

/** A file name from a title: no path characters, a sensible length, the extension once. */
export function downloadFilename(title: string, extension: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .slice(0, 80);
  const ext = extension.replace(/^\./u, "").toLowerCase();
  if (!ext) return base || "download";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base || "download"}.${ext}`;
}

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "video/mp4": "mp4",
};

function extensionOf(name: string | undefined, file: RetainedArtifactReference): string {
  return (
    (name ?? "").match(/\.([A-Za-z0-9]{1,8})$/u)?.[1] ??
    MIME_EXTENSION[file.contentType.split(";")[0]!.trim().toLowerCase()] ??
    ""
  );
}

function cacheFile(name: string): File {
  const folder = new Directory(Paths.cache, "opengeni-downloads");
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  const file = new File(folder, name);
  if (file.exists) file.delete();
  return file;
}

async function hand(file: File, mimeType: string): Promise<void> {
  if (Platform.OS === "ios") {
    await Share.share({ url: file.uri });
    return;
  }
  let target: Directory;
  try {
    target = await Directory.pickDirectoryAsync();
  } catch {
    // The person closed the folder picker: nothing to save, nothing went wrong.
    return;
  }
  const saved = target.createFile(file.name, mimeType);
  saved.write(await file.bytes());
  Alert.alert("Saved", file.name);
}

async function exportSpreadsheet(
  client: DownloadClient,
  workspaceId: string,
  artifactId: string,
): Promise<Uint8Array> {
  const replicaId = newReplicaId();
  await client.getEditableArtifact(workspaceId, artifactId, { replicaId });
  const version = await client.pinEditableArtifactVersion(workspaceId, artifactId, {
    replicaId,
    idempotencyKey: Crypto.randomUUID(),
    name: "XLSX download",
  });
  let job = await client.createEditableArtifactMaterialization(workspaceId, artifactId, {
    replicaId,
    idempotencyKey: Crypto.randomUUID(),
    versionId: version.id,
    format: "xlsx",
  });
  const deadline = Date.now() + EXPORT_DEADLINE_MS;
  while (job.state === "pending" || job.state === "running") {
    if (Date.now() >= deadline) throw new Error("Export is taking too long. Try again.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = await client.getEditableArtifactMaterialization(workspaceId, artifactId, job.id, {
      replicaId,
    });
  }
  if (job.state !== "succeeded" || !job.result) throw new Error("Couldn't export this workbook.");
  const response = await client.downloadEditableArtifactMaterialization(
    workspaceId,
    artifactId,
    job.id,
    { replicaId },
  );
  return new Uint8Array(await response.arrayBuffer());
}

/** Download an artifact and hand it to the system. Throws with words to show. */
export async function downloadArtifact(
  client: DownloadClient,
  workspaceId: string,
  item: Pick<ArtifactCatalogItem, "kind" | "id" | "title" | "versionId" | "file" | "filename">,
): Promise<void> {
  const format = downloadFormat(item);
  if (format === "html") {
    const html = await client.getWorkspaceArtifactHtml(workspaceId, item.id, {
      versionId: item.versionId!,
    });
    const file = cacheFile(downloadFilename(item.title, "html"));
    file.write(html);
    await hand(file, "text/html");
    return;
  }
  if (format === "xlsx") {
    const bytes = await exportSpreadsheet(client, workspaceId, item.id);
    const file = cacheFile(downloadFilename(item.title, "xlsx"));
    file.write(bytes);
    await hand(file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return;
  }
  if (format === "original" && item.file) {
    const link = await client.createRetainedArtifactDownloadUrl(workspaceId, item.file);
    const name = downloadFilename(
      item.filename ?? item.title,
      extensionOf(item.filename ?? undefined, item.file),
    );
    const file = await File.downloadFileAsync(link.url, cacheFile(name), { idempotent: true });
    await hand(file, item.file.contentType || "application/octet-stream");
    return;
  }
  throw new Error("This artifact can't be downloaded.");
}
