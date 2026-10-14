import type { OpenGeniClient } from "@opengeni/sdk/artifacts";
import type { OpenedEditableArtifact } from "@opengeni/react/artifacts";

/** Export a server-pinned native head, never the imported file or a browser projection. */
export async function downloadSpreadsheet(
  client: OpenGeniClient,
  workspaceId: string,
  opened: OpenedEditableArtifact,
  signal: AbortSignal,
): Promise<Blob> {
  if (opened.artifact.modality !== "spreadsheet") throw new Error("Only XLSX is supported.");
  const { replicaId, artifact } = opened;
  const version = await client.pinEditableArtifactVersion(
    workspaceId,
    artifact.id,
    { replicaId, idempotencyKey: crypto.randomUUID(), name: "XLSX download" },
    { signal },
  );
  let job = await client.createEditableArtifactMaterialization(
    workspaceId,
    artifact.id,
    { replicaId, idempotencyKey: crypto.randomUUID(), versionId: version.id, format: "xlsx" },
    { signal },
  );
  const deadline = Date.now() + 120_000;
  while (job.state === "pending" || job.state === "running") {
    if (Date.now() >= deadline) throw new Error("Export is taking too long. Try again.");
    await pollDelay(signal);
    job = await client.getEditableArtifactMaterialization(workspaceId, artifact.id, job.id, {
      replicaId,
      signal,
    });
  }
  if (job.state !== "succeeded" || !job.result) throw new Error("Could not export this workbook.");
  const response = await client.downloadEditableArtifactMaterialization(
    workspaceId,
    artifact.id,
    job.id,
    { replicaId, signal },
  );
  signal.throwIfAborted();
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  return new Blob([bytes], { type: job.result.mimeType });
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
