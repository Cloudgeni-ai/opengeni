export type ModalCheckpointProviderBinding = {
  version: 1;
  serverUrl: string;
  workspaceName: string;
  environment: string;
};

/**
 * One canonical, non-secret identity for the Modal namespace that owns a
 * checkpoint. The same bytes are used for uniqueness, durable storage, and
 * destructive-call fencing.
 */
export function canonicalModalCheckpointProviderBinding(
  value: unknown,
): { binding: ModalCheckpointProviderBinding; key: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ModalCheckpointProviderBinding>;
  if (
    candidate.version !== 1 ||
    typeof candidate.serverUrl !== "string" ||
    candidate.serverUrl.trim().length === 0 ||
    typeof candidate.workspaceName !== "string" ||
    candidate.workspaceName.trim().length === 0 ||
    typeof candidate.environment !== "string"
  ) {
    return null;
  }
  const binding: ModalCheckpointProviderBinding = {
    version: 1,
    serverUrl: candidate.serverUrl,
    workspaceName: candidate.workspaceName,
    environment: candidate.environment,
  };
  const key = JSON.stringify(binding);
  return key.length <= 1024 ? { binding, key } : null;
}
