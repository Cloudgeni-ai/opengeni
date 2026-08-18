import {
  COMMITTED_TRANSACTION_PROTOCOL_VERSION,
  DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION,
  DOCUMENT_ARTIFACT_SNAPSHOT_VERSION,
  PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION,
  PRESENTATION_ARTIFACT_SNAPSHOT_VERSION,
  SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
  SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
} from "@opengeni/contracts/editable-artifact-versions";
import type { Document } from "./document";
import {
  NativeDocumentSession,
  NativePresentationSession,
  NativeSpreadsheetSession,
} from "./native";
import type { Presentation } from "./presentation";
import { requireCompositeState } from "./production-composite";
import type { Workbook } from "./spreadsheet";

type ArtifactSnapshotCommon = Readonly<{
  schemaVersion: 1;
  runtimeTarget: string;
  kernelVersion: string;
  stateHash: string;
  snapshotBytes: Uint8Array;
}>;

/** Exact native-canonical state at one durable artifact boundary. */
export type ArtifactSnapshot =
  | (ArtifactSnapshotCommon &
      Readonly<{
        modality: "spreadsheet";
        modelSchemaVersion: typeof SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION;
        snapshotVersion: typeof SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION;
        coveredCausalFrontierBytes: Uint8Array;
        operationProtocolVersion: typeof COMMITTED_TRANSACTION_PROTOCOL_VERSION;
        crdtStateVersion: typeof SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION;
      }>)
  | (ArtifactSnapshotCommon &
      Readonly<{
        modality: "document";
        modelSchemaVersion: typeof DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION;
        snapshotVersion: typeof DOCUMENT_ARTIFACT_SNAPSHOT_VERSION;
        nativeRevision: number;
      }>)
  | (ArtifactSnapshotCommon &
      Readonly<{
        modality: "presentation";
        modelSchemaVersion: typeof PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION;
        snapshotVersion: typeof PRESENTATION_ARTIFACT_SNAPSHOT_VERSION;
        nativeRevision: number;
      }>);

/** Capture one immutable native snapshot from an open artifact object. */
export function createArtifactSnapshot(
  artifact: Workbook | Document | Presentation,
): ArtifactSnapshot {
  const state = requireCompositeState(artifact);
  const native = state.native;
  const common = {
    schemaVersion: 1 as const,
    runtimeTarget: native.target,
    kernelVersion: native.buildIdentity,
    stateHash: native.stateHash(),
    snapshotBytes: Uint8Array.from(native.snapshot()),
  };
  if (state.modality === "spreadsheet") {
    if (!(native instanceof NativeSpreadsheetSession)) {
      throw new Error("Spreadsheet composite does not own a spreadsheet native session");
    }
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      modelSchemaVersion: SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
      snapshotVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
      coveredCausalFrontierBytes: Uint8Array.from(native.frontier()),
      operationProtocolVersion: COMMITTED_TRANSACTION_PROTOCOL_VERSION,
      crdtStateVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
    });
  }
  if (
    !(native instanceof NativeDocumentSession) &&
    !(native instanceof NativePresentationSession)
  ) {
    throw new Error("Serialized composite does not own its expected native session");
  }
  const nativeRevision = safeNativeRevision(native.revision());
  return state.modality === "document"
    ? Object.freeze({
        ...common,
        modality: "document" as const,
        modelSchemaVersion: DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION,
        snapshotVersion: DOCUMENT_ARTIFACT_SNAPSHOT_VERSION,
        nativeRevision,
      })
    : Object.freeze({
        ...common,
        modality: "presentation" as const,
        modelSchemaVersion: PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION,
        snapshotVersion: PRESENTATION_ARTIFACT_SNAPSHOT_VERSION,
        nativeRevision,
      });
}

function safeNativeRevision(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Artifact native revision exceeds the durable range");
  }
  return Number(value);
}
