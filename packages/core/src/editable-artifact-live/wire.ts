import {
  EDITABLE_ARTIFACT_LIVE_WIRE_VERSION,
  decodeEditableArtifactLiveClientWireFrame as decodeContractClientFrame,
  decodeEditableArtifactLiveServerWireFrame,
  encodeEditableArtifactLiveAppliedWireFrame as encodeContractAppliedFrame,
  encodeEditableArtifactLiveMutationWireFrame as encodeContractMutationFrame,
  encodeEditableArtifactLiveOpenWireFrame as encodeContractOpenFrame,
  encodeEditableArtifactLiveServerWireFrame as encodeContractServerFrame,
  inspectEditableArtifactLiveWireEnvelope,
  type EditableArtifactLiveAppliedWireFrame as ContractAppliedWireFrame,
  type EditableArtifactLiveMutationWireFrame as ContractMutationWireFrame,
  type EditableArtifactLiveOpenWireFrame as ContractOpenWireFrame,
  type EditableArtifactLiveServerFrame as ContractServerFrame,
} from "@opengeni/contracts/editable-artifact-live";
import type {
  EditableArtifactId,
  EditableArtifactRequestHash,
  EditableArtifactStateHash,
} from "../domain/editable-artifacts/types";
import type { EditableArtifactLiveResume, EditableArtifactLiveServerFrame } from "./types";

export {
  EDITABLE_ARTIFACT_LIVE_WIRE_VERSION,
  decodeEditableArtifactLiveServerWireFrame,
  inspectEditableArtifactLiveWireEnvelope,
};

/** Branded core view over the contracts-owned wire type. Runtime validation is contracts-only. */
export type EditableArtifactLiveOpenWireFrame = Readonly<{
  type: "open";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  token: string;
  resume: EditableArtifactLiveResume;
}>;
export type EditableArtifactLiveAppliedWireFrame = Readonly<{
  type: "applied";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
  sequence: number;
  stateHash: EditableArtifactStateHash;
}>;
export type EditableArtifactLiveMutationWireFrame = Readonly<{
  type: "mutation";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
  requestHash: EditableArtifactRequestHash;
  intentBytes: Uint8Array;
}>;
export type EditableArtifactLiveClientWireFrame =
  | EditableArtifactLiveOpenWireFrame
  | EditableArtifactLiveAppliedWireFrame
  | EditableArtifactLiveMutationWireFrame;

export function decodeEditableArtifactLiveClientWireFrame(
  bytes: Uint8Array,
): EditableArtifactLiveClientWireFrame {
  return decodeContractClientFrame(bytes) as unknown as EditableArtifactLiveClientWireFrame;
}

export function encodeEditableArtifactLiveOpenWireFrame(
  frame: EditableArtifactLiveOpenWireFrame,
): Uint8Array {
  return encodeContractOpenFrame(frame as unknown as ContractOpenWireFrame);
}

export function encodeEditableArtifactLiveAppliedWireFrame(
  frame: EditableArtifactLiveAppliedWireFrame,
): Uint8Array {
  return encodeContractAppliedFrame(frame as unknown as ContractAppliedWireFrame);
}

export function encodeEditableArtifactLiveMutationWireFrame(
  frame: EditableArtifactLiveMutationWireFrame,
): Uint8Array {
  return encodeContractMutationFrame(frame as unknown as ContractMutationWireFrame);
}

export function encodeEditableArtifactLiveServerWireFrame(
  frame: EditableArtifactLiveServerFrame,
): Uint8Array {
  if (frame.type === "transaction" && frame.transaction.modality === "spreadsheet") {
    const { operationProtocolVersion, modality: _modality, ...transaction } = frame.transaction;
    return encodeContractServerFrame({
      ...frame,
      transaction: {
        ...transaction,
        protocolVersion: operationProtocolVersion,
      },
    } as unknown as ContractServerFrame);
  }
  return encodeContractServerFrame(frame as unknown as ContractServerFrame);
}
