export type ModalCheckpointProviderBinding = {
  version: 1;
  serverUrl: string;
  workspaceName: string;
  environment: string;
};

export type DockerProviderImageBinding = {
  version: 1;
  endpoint: string;
  daemonId: string;
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

/**
 * Canonical non-secret identity for the Docker daemon that physically owns a
 * provider image. The endpoint prevents a mutable local context name from
 * being treated as authority, while the daemon ID fences endpoint reuse.
 */
export function canonicalDockerProviderImageBinding(
  value: unknown,
): { binding: DockerProviderImageBinding; key: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DockerProviderImageBinding>;
  if (
    candidate.version !== 1 ||
    typeof candidate.endpoint !== "string" ||
    candidate.endpoint.trim() !== candidate.endpoint ||
    candidate.endpoint.length === 0 ||
    candidate.endpoint.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(candidate.endpoint) ||
    typeof candidate.daemonId !== "string" ||
    candidate.daemonId.trim() !== candidate.daemonId ||
    candidate.daemonId.length === 0 ||
    candidate.daemonId.length > 192 ||
    !/^[A-Za-z0-9._:+/-]+$/u.test(candidate.daemonId)
  ) {
    return null;
  }
  const binding: DockerProviderImageBinding = {
    version: 1,
    endpoint: candidate.endpoint,
    daemonId: candidate.daemonId,
  };
  const key = JSON.stringify(binding);
  return key.length <= 1024 ? { binding, key } : null;
}
