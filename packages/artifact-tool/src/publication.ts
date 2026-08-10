import {
  COMMITTED_TRANSACTION_PROTOCOL_VERSION,
  EDITABLE_ARTIFACT_MODEL_SCHEMA_VERSION,
  EDITABLE_ARTIFACT_SNAPSHOT_VERSION,
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

type ArtifactPublicationSnapshotCommon = Readonly<{
  schemaVersion: 1;
  modality: "spreadsheet" | "document" | "presentation";
  runtimeTarget: string;
  kernelVersion: string;
  modelSchemaVersion: 1;
  snapshotVersion: 1;
  stateHash: string;
  snapshotBytes: Uint8Array;
}>;

/** Exact native-canonical state for the durable editable-artifact import boundary. */
export type ArtifactPublicationSnapshot =
  | (ArtifactPublicationSnapshotCommon &
      Readonly<{
        modality: "spreadsheet";
        coveredCausalFrontierBytes: Uint8Array;
        operationProtocolVersion: 1;
        crdtStateVersion: 1;
      }>)
  | (ArtifactPublicationSnapshotCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

/** Captures one immutable, native-canonical publication boundary. */
export function createArtifactPublicationSnapshot(
  artifact: Workbook | Document | Presentation,
): ArtifactPublicationSnapshot {
  const state = requireCompositeState(artifact);
  const native = state.native;
  const common = {
    schemaVersion: 1 as const,
    modality: state.modality,
    runtimeTarget: native.target,
    kernelVersion: native.buildIdentity,
    modelSchemaVersion: EDITABLE_ARTIFACT_MODEL_SCHEMA_VERSION,
    snapshotVersion: EDITABLE_ARTIFACT_SNAPSHOT_VERSION,
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
      coveredCausalFrontierBytes: Uint8Array.from(native.frontier()),
      operationProtocolVersion: COMMITTED_TRANSACTION_PROTOCOL_VERSION,
      crdtStateVersion: EDITABLE_ARTIFACT_SNAPSHOT_VERSION,
    });
  }
  if (
    !(native instanceof NativeDocumentSession) &&
    !(native instanceof NativePresentationSession)
  ) {
    throw new Error("Serialized composite does not own its expected native session");
  }
  return Object.freeze({
    ...common,
    modality: state.modality,
    nativeRevision: safePublicationRevision(native.revision()),
  });
}

function safePublicationRevision(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Artifact native revision exceeds the durable publication range");
  }
  return Number(value);
}
