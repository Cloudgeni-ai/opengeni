/** Historical source imports remain readable; new Drive work uses one MCP connection. */
export const GOOGLE_DRIVE_NATIVE_RETIRED_REASON = "google_drive_native_retired" as const;
export const GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE =
  "Previous Google Drive sync and publishing setup has been retired. Connect Google Drive MCP, then create an ordinary agent schedule for recurring work. Imported documents and run history remain.";
export function isRetiredNativeGoogleDriveSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const connection = (source as { connection?: unknown }).connection;
  if (!connection || typeof connection !== "object") return false;
  const provider = (connection as { providerDomain?: unknown }).providerDomain;
  return provider === "googleapis.com" || provider === "www.googleapis.com";
}
export function isRetiredNativeGoogleDriveTask(task: {
  agentConfig?: { knowledgeSource?: unknown } | null;
  action?: { kind?: unknown } | null;
}): boolean {
  return (
    isRetiredNativeGoogleDriveSource(task.agentConfig?.knowledgeSource) ||
    (task.action?.kind === "knowledge_source_sync" && isRetiredNativeGoogleDriveSource(task.action))
  );
}
