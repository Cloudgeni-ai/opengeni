import type { AccessContext, Workspace } from "@opengeni/sdk";
import {
  createEditableArtifactReplicaId,
  type EditableArtifactCacheAuthority,
} from "@opengeni/sdk/editable-artifacts";

export async function createConsoleEditableArtifactAuthority(
  input: Readonly<{
    deploymentOrigin: string;
    workspace: Workspace | undefined;
    accessContext: AccessContext;
    accessKeyVersion: number;
  }>,
): Promise<EditableArtifactCacheAuthority> {
  const workspace = input.workspace;
  if (!workspace) throw new Error("You do not have access to this workspace.");
  const grant = input.accessContext.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspace.id,
  );
  if (
    !grant ||
    grant.accountId !== workspace.accountId ||
    grant.subjectId !== input.accessContext.subjectId
  ) {
    throw new Error("You do not have access to this workspace.");
  }
  const authorizationEpoch = await sha256(
    JSON.stringify({
      accessKeyVersion: input.accessKeyVersion,
      mode: input.accessContext.mode,
      subjectId: input.accessContext.subjectId,
      accountId: grant.accountId,
      permissions: [...grant.permissions].sort(),
      principalKind: grant.principalKind ?? null,
    }),
  );
  return Object.freeze({
    deploymentOrigin: new URL(input.deploymentOrigin).origin,
    accountId: workspace.accountId,
    workspaceId: workspace.id,
    principalId: input.accessContext.subjectId,
    authorizationEpoch,
  });
}

export function getOrCreateConsoleEditableArtifactReplicaId(
  input: Readonly<{
    authority: EditableArtifactCacheAuthority;
    artifactId: string;
    storage?: Pick<Storage, "getItem" | "setItem">;
    createReplicaId?: () => string;
  }>,
): string {
  if (!/^[0-9a-f]{32}$/u.test(input.artifactId) || /^0+$/u.test(input.artifactId)) {
    throw new Error("Editable artifact ID is malformed.");
  }
  const key = consoleEditableArtifactReplicaStorageKey(input.authority, input.artifactId);
  let storage: Pick<Storage, "getItem" | "setItem">;
  let existing: string | null;
  try {
    storage = input.storage ?? globalThis.localStorage;
    existing = storage.getItem(key);
  } catch {
    throw new Error("Browser storage is required for durable offline editing.");
  }
  if (existing && /^[0-9a-f]{16}$/u.test(existing) && !/^0+$/u.test(existing)) return existing;
  const replicaId = (input.createReplicaId ?? createEditableArtifactReplicaId)();
  if (!/^[0-9a-f]{16}$/u.test(replicaId) || /^0+$/u.test(replicaId)) {
    throw new Error("Could not create a valid editable artifact writer identity.");
  }
  try {
    storage.setItem(key, replicaId);
    return replicaId;
  } catch {
    throw new Error("Browser storage is required for durable offline editing.");
  }
}

export function consoleEditableArtifactReplicaStorageKey(
  authority: EditableArtifactCacheAuthority,
  artifactId: string,
): string {
  return `opengeni:editable-artifact-replica:v1:${JSON.stringify([
    new URL(authority.deploymentOrigin).origin,
    authority.accountId,
    authority.workspaceId,
    authority.principalId,
    artifactId,
  ])}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
