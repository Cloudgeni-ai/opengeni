import {
  DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES,
  DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS,
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  DOCUMENT_ARTIFACT_QUERY_MAX_BYTES,
  DOCUMENT_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  DOCUMENT_ARTIFACT_QUERY_RESPONSE_VERSION,
  DOCUMENT_ARTIFACT_QUERY_VERSION,
  assertCanonicalDocumentArtifactCommandBytes,
  assertCanonicalDocumentArtifactQueryBytes,
  assertCanonicalDocumentArtifactQueryResponseBytes,
  decodeDocumentArtifactCommandBatch,
  decodeDocumentArtifactQuery,
  decodeDocumentArtifactQueryResponse,
  encodeDocumentArtifactCommandBatch,
  encodeDocumentArtifactQuery,
  encodeDocumentArtifactQueryResponse,
} from "./document-artifact-commands";
import {
  PRESENTATION_ARTIFACT_COMMAND_MAX_BYTES,
  PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS,
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  PRESENTATION_ARTIFACT_QUERY_MAX_BYTES,
  PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  PRESENTATION_ARTIFACT_QUERY_RESPONSE_VERSION,
  PRESENTATION_ARTIFACT_QUERY_VERSION,
  assertCanonicalPresentationArtifactCommandBytes,
  assertCanonicalPresentationArtifactQueryBytes,
  assertCanonicalPresentationArtifactQueryResponseBytes,
  decodePresentationArtifactCommandBatch,
  decodePresentationArtifactQuery,
  decodePresentationArtifactQueryResponse,
  encodePresentationArtifactCommandBatch,
  encodePresentationArtifactQuery,
  encodePresentationArtifactQueryResponse,
} from "./presentation-artifact-commands";
import {
  SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES,
  SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  assertCanonicalSpreadsheetArtifactCommandBytes,
  decodeSpreadsheetArtifactCommandBatch,
  encodeSpreadsheetArtifactCommandBatch,
} from "./spreadsheet-artifact-commands";
import {
  SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
  SPREADSHEET_ARTIFACT_QUERY_MAX_BYTES,
  SPREADSHEET_ARTIFACT_QUERY_VERSION,
  assertCanonicalSpreadsheetArtifactKernelProjectionBytes,
  assertCanonicalSpreadsheetArtifactKernelQueryBytes,
  decodeSpreadsheetArtifactKernelProjection,
  decodeSpreadsheetArtifactKernelQuery,
  encodeSpreadsheetArtifactKernelProjection,
  encodeSpreadsheetArtifactKernelQuery,
} from "./spreadsheet-artifact-query";
import {
  EDITABLE_ARTIFACT_MODEL_SCHEMA_VERSION,
  EDITABLE_ARTIFACT_SNAPSHOT_VERSION,
} from "./editable-artifact-versions";

export {
  EDITABLE_ARTIFACT_MODEL_SCHEMA_VERSION,
  EDITABLE_ARTIFACT_SNAPSHOT_VERSION,
} from "./editable-artifact-versions";

export type EditableArtifactModality = "spreadsheet" | "document" | "presentation";
export type EditableArtifactConcurrencySemantics =
  | "causal-crdt-v1"
  | "authoritative-serialized-stale-base-v1";

export type EditableArtifactCodecDescriptor = Readonly<{
  modality: EditableArtifactModality;
  modelSchemaVersion: typeof EDITABLE_ARTIFACT_MODEL_SCHEMA_VERSION;
  snapshotVersion: typeof EDITABLE_ARTIFACT_SNAPSHOT_VERSION;
  command: Readonly<{
    magic: "OGASC001" | "OGADC001" | "OGAPC001";
    version: 1;
    maximumBytes: number;
    maximumCommands: number;
    encode: (value: unknown) => Uint8Array;
    decode: (bytes: Uint8Array) => unknown;
    assertCanonical: (bytes: Uint8Array) => void;
  }>;
  query: Readonly<{
    magic: "OGAKQ001" | "OGADQ001" | "OGAPQ001";
    responseMagic: "OGAKV001" | "OGADP001" | "OGAPV001";
    version: 1;
    responseVersion: 1;
    maximumBytes: number;
    maximumResponseBytes: number;
    encode: (value: unknown) => Uint8Array;
    decode: (bytes: Uint8Array) => unknown;
    assertCanonical: (bytes: Uint8Array) => void;
    encodeResponse: (value: unknown) => Uint8Array;
    decodeResponse: (bytes: Uint8Array) => unknown;
    assertCanonicalResponse: (bytes: Uint8Array) => void;
  }>;
  concurrency: Readonly<{
    semantics: EditableArtifactConcurrencySemantics;
    collaborationEnvelope: "OGACO001" | null;
    staleBaseMustBeRejected: boolean;
  }>;
}>;

const spreadsheet = Object.freeze({
  modality: "spreadsheet",
  modelSchemaVersion: 1,
  snapshotVersion: 1,
  command: Object.freeze({
    magic: "OGASC001",
    version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
    maximumBytes: SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES,
    maximumCommands: SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS,
    encode: (value: unknown) =>
      encodeSpreadsheetArtifactCommandBatch(
        value as Parameters<typeof encodeSpreadsheetArtifactCommandBatch>[0],
      ),
    decode: decodeSpreadsheetArtifactCommandBatch,
    assertCanonical: assertCanonicalSpreadsheetArtifactCommandBytes,
  }),
  query: Object.freeze({
    magic: "OGAKQ001",
    responseMagic: "OGAKV001",
    version: SPREADSHEET_ARTIFACT_QUERY_VERSION,
    responseVersion: SPREADSHEET_ARTIFACT_QUERY_VERSION,
    maximumBytes: SPREADSHEET_ARTIFACT_QUERY_MAX_BYTES,
    maximumResponseBytes: SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
    encode: (value: unknown) =>
      encodeSpreadsheetArtifactKernelQuery(
        value as Parameters<typeof encodeSpreadsheetArtifactKernelQuery>[0],
      ),
    decode: decodeSpreadsheetArtifactKernelQuery,
    assertCanonical: assertCanonicalSpreadsheetArtifactKernelQueryBytes,
    encodeResponse: (value: unknown) =>
      encodeSpreadsheetArtifactKernelProjection(
        value as Parameters<typeof encodeSpreadsheetArtifactKernelProjection>[0],
      ),
    decodeResponse: decodeSpreadsheetArtifactKernelProjection,
    assertCanonicalResponse: assertCanonicalSpreadsheetArtifactKernelProjectionBytes,
  }),
  concurrency: Object.freeze({
    semantics: "causal-crdt-v1",
    collaborationEnvelope: "OGACO001",
    staleBaseMustBeRejected: false,
  }),
}) satisfies EditableArtifactCodecDescriptor;

const document = Object.freeze({
  modality: "document",
  modelSchemaVersion: 1,
  snapshotVersion: 1,
  command: Object.freeze({
    magic: "OGADC001",
    version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
    maximumBytes: DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES,
    maximumCommands: DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS,
    encode: (value: unknown) =>
      encodeDocumentArtifactCommandBatch(
        value as Parameters<typeof encodeDocumentArtifactCommandBatch>[0],
      ),
    decode: decodeDocumentArtifactCommandBatch,
    assertCanonical: assertCanonicalDocumentArtifactCommandBytes,
  }),
  query: Object.freeze({
    magic: "OGADQ001",
    responseMagic: "OGADP001",
    version: DOCUMENT_ARTIFACT_QUERY_VERSION,
    responseVersion: DOCUMENT_ARTIFACT_QUERY_RESPONSE_VERSION,
    maximumBytes: DOCUMENT_ARTIFACT_QUERY_MAX_BYTES,
    maximumResponseBytes: DOCUMENT_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
    encode: (value: unknown) =>
      encodeDocumentArtifactQuery(value as Parameters<typeof encodeDocumentArtifactQuery>[0]),
    decode: decodeDocumentArtifactQuery,
    assertCanonical: assertCanonicalDocumentArtifactQueryBytes,
    encodeResponse: (value: unknown) =>
      encodeDocumentArtifactQueryResponse(
        value as Parameters<typeof encodeDocumentArtifactQueryResponse>[0],
      ),
    decodeResponse: decodeDocumentArtifactQueryResponse,
    assertCanonicalResponse: assertCanonicalDocumentArtifactQueryResponseBytes,
  }),
  concurrency: Object.freeze({
    semantics: "authoritative-serialized-stale-base-v1",
    collaborationEnvelope: null,
    staleBaseMustBeRejected: true,
  }),
}) satisfies EditableArtifactCodecDescriptor;

const presentation = Object.freeze({
  modality: "presentation",
  modelSchemaVersion: 1,
  snapshotVersion: 1,
  command: Object.freeze({
    magic: "OGAPC001",
    version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
    maximumBytes: PRESENTATION_ARTIFACT_COMMAND_MAX_BYTES,
    maximumCommands: PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS,
    encode: (value: unknown) =>
      encodePresentationArtifactCommandBatch(
        value as Parameters<typeof encodePresentationArtifactCommandBatch>[0],
      ),
    decode: decodePresentationArtifactCommandBatch,
    assertCanonical: assertCanonicalPresentationArtifactCommandBytes,
  }),
  query: Object.freeze({
    magic: "OGAPQ001",
    responseMagic: "OGAPV001",
    version: PRESENTATION_ARTIFACT_QUERY_VERSION,
    responseVersion: PRESENTATION_ARTIFACT_QUERY_RESPONSE_VERSION,
    maximumBytes: PRESENTATION_ARTIFACT_QUERY_MAX_BYTES,
    maximumResponseBytes: PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
    encode: (value: unknown) =>
      encodePresentationArtifactQuery(
        value as Parameters<typeof encodePresentationArtifactQuery>[0],
      ),
    decode: decodePresentationArtifactQuery,
    assertCanonical: assertCanonicalPresentationArtifactQueryBytes,
    encodeResponse: (value: unknown) =>
      encodePresentationArtifactQueryResponse(
        value as Parameters<typeof encodePresentationArtifactQueryResponse>[0],
      ),
    decodeResponse: decodePresentationArtifactQueryResponse,
    assertCanonicalResponse: assertCanonicalPresentationArtifactQueryResponseBytes,
  }),
  concurrency: Object.freeze({
    semantics: "authoritative-serialized-stale-base-v1",
    collaborationEnvelope: null,
    staleBaseMustBeRejected: true,
  }),
}) satisfies EditableArtifactCodecDescriptor;

export const EDITABLE_ARTIFACT_CODEC_REGISTRY: Readonly<
  Record<EditableArtifactModality, EditableArtifactCodecDescriptor>
> = Object.freeze({ spreadsheet, document, presentation });

/**
 * Selects solely from the durable artifact modality plus persisted versions.
 * Modality intentionally never enters OGATX001: the durable artifact row is
 * authoritative and prevents client-controlled cross-modality decoding.
 */
export function editableArtifactCodecFor(
  input: Readonly<{
    durableModality: EditableArtifactModality;
    modelSchemaVersion: number;
    commandProtocolVersion: number;
  }>,
): EditableArtifactCodecDescriptor {
  const descriptor = EDITABLE_ARTIFACT_CODEC_REGISTRY[input.durableModality];
  if (!descriptor) throw new TypeError("unsupported durable editable artifact modality");
  if (input.modelSchemaVersion !== descriptor.modelSchemaVersion) {
    throw new TypeError(
      "editable artifact model schema version is incompatible with its durable modality",
    );
  }
  if (input.commandProtocolVersion !== descriptor.command.version) {
    throw new TypeError(
      "editable artifact command protocol version is incompatible with its durable modality",
    );
  }
  return descriptor;
}
