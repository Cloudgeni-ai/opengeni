import type { OpenGeniClient } from "@opengeni/sdk/artifacts";
import type { OpenedEditableArtifact } from "@opengeni/react/artifacts";

import { downloadEditableArtifact } from "./editable-artifact-download";

/** XLSX-only entry point kept for spreadsheet fixtures and callers. */
export async function downloadSpreadsheet(
  client: OpenGeniClient,
  workspaceId: string,
  opened: OpenedEditableArtifact,
  signal: AbortSignal,
): Promise<Blob> {
  if (opened.artifact.modality !== "spreadsheet") throw new Error("Only XLSX is supported.");
  return downloadEditableArtifact(client, workspaceId, opened, signal);
}
