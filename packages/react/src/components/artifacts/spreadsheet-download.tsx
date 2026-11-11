import type { EditableArtifactSession } from "@opengeni/sdk/editable-artifacts";

import { EditableArtifactDownloadButton, type EditableArtifactDownload } from "./artifact-download";

export type SpreadsheetDownload = EditableArtifactDownload;

export function SpreadsheetDownloadButton(props: {
  session: EditableArtifactSession;
  title: string;
  download: SpreadsheetDownload;
}) {
  return <EditableArtifactDownloadButton {...props} format="xlsx" />;
}
