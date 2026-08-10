import {
  EditableArtifactDurableExportPersistenceError,
  type PostgresEditableArtifactDurableExportStore,
  type PersistedEditableArtifactMaterializationJob,
  type PersistedEditableArtifactPinnedVersion,
} from "@opengeni/db/editable-artifact-durable-export";

import {
  EditableArtifactDurableExportError,
  validateEditableArtifactMaterializationJob,
  validateEditableArtifactPinnedVersion,
  type EditableArtifactDurableExportStorePort,
  type EditableArtifactMaterializationJob,
  type EditableArtifactPinnedVersion,
  type EnqueueEditableArtifactMaterializationStoreRequest,
  type PinEditableArtifactVersionStoreRequest,
} from "./durable-export";

/** One-way adapter keeps @opengeni/db free of the core package cycle. */
export function editableArtifactDurableExportStorePortFromPostgres(
  store: PostgresEditableArtifactDurableExportStore,
): EditableArtifactDurableExportStorePort {
  return Object.freeze({
    async pinVersion(input: PinEditableArtifactVersionStoreRequest) {
      try {
        const result = await store.pinVersion(persistedPinRequest(input));
        if (result.kind === "authorization_stale") return result;
        return Object.freeze({
          kind: "result" as const,
          version: versionFromPersisted(result.value.version),
          replayed: result.value.replayed,
        });
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async enqueueMaterialization(input: EnqueueEditableArtifactMaterializationStoreRequest) {
      try {
        const result = await store.enqueueMaterialization(persistedEnqueueRequest(input));
        if (result.kind === "authorization_stale") return result;
        return Object.freeze({
          kind: "result" as const,
          job: jobFromPersisted(result.value.job),
          replayed: result.value.replayed,
        });
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async readVersion(input: Parameters<EditableArtifactDurableExportStorePort["readVersion"]>[0]) {
      try {
        const result = await store.readVersion(input);
        if (result.kind === "authorization_stale") return result;
        return Object.freeze({
          kind: "result" as const,
          version: result.value ? versionFromPersisted(result.value) : null,
        });
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async readMaterialization(
      input: Parameters<EditableArtifactDurableExportStorePort["readMaterialization"]>[0],
    ) {
      try {
        const result = await store.readMaterialization(input);
        if (result.kind === "authorization_stale") return result;
        return Object.freeze({
          kind: "result" as const,
          job: result.value ? jobFromPersisted(result.value) : null,
        });
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async readMaterializationDownload(
      input: Parameters<EditableArtifactDurableExportStorePort["readMaterializationDownload"]>[0],
    ) {
      try {
        const result = await store.readMaterializationDownload(input);
        if (result.kind === "authorization_stale") return result;
        return Object.freeze({
          kind: "result" as const,
          job: result.value.job ? jobFromPersisted(result.value.job) : null,
          objectReference: result.value.objectReference,
        });
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
  });
}

function persistedPinRequest(input: PinEditableArtifactVersionStoreRequest) {
  const snapshot = input.snapshot;
  return {
    ...input,
    snapshot: {
      modality: snapshot.modality,
      snapshotId: snapshot.snapshotId,
      coveredHeadSequence: snapshot.coveredHeadSequence,
      stateHash: snapshot.stateHash,
      coveredCausalFrontier:
        snapshot.modality === "spreadsheet" ? snapshot.coveredCausalFrontier : null,
      nativeRevision: snapshot.modality === "spreadsheet" ? null : snapshot.nativeRevision,
    },
  } as const;
}

function persistedEnqueueRequest(input: EnqueueEditableArtifactMaterializationStoreRequest) {
  return { ...input } as const;
}

function versionFromPersisted(
  value: PersistedEditableArtifactPinnedVersion,
): EditableArtifactPinnedVersion {
  return validateEditableArtifactPinnedVersion(value as EditableArtifactPinnedVersion);
}

function jobFromPersisted(
  value: PersistedEditableArtifactMaterializationJob,
): EditableArtifactMaterializationJob {
  return validateEditableArtifactMaterializationJob(value as EditableArtifactMaterializationJob);
}

function mapPersistenceError(error: unknown): unknown {
  if (!(error instanceof EditableArtifactDurableExportPersistenceError)) return error;
  switch (error.code) {
    case "not_found":
      return new EditableArtifactDurableExportError("not_found");
    case "idempotency_conflict":
    case "snapshot_conflict":
      return new EditableArtifactDurableExportError("conflict");
    case "unsupported_format":
      return new EditableArtifactDurableExportError("unsupported_format");
    case "database_contract_violation":
      return new EditableArtifactDurableExportError("unavailable");
  }
}
