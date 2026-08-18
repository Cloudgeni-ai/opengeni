import { createHash } from "node:crypto";
import { decodeEditableArtifactCausalFrontier } from "@opengeni/contracts/editable-artifact-causal-frontier";
import {
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  currentEditableArtifactCompatibility,
} from "@opengeni/contracts/editable-artifacts";
import {
  COMMITTED_TRANSACTION_PROTOCOL_VERSION,
  DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION,
  PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION,
  SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
  SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
} from "@opengeni/contracts/editable-artifact-versions";
import type { ArtifactSnapshot } from "./snapshot";

export type ArtifactOfficeModality = "spreadsheet" | "document" | "presentation";
export type ArtifactOfficeMimeType =
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type PreparedArtifactOfficeImport = Readonly<{
  source: Readonly<{
    filename: string;
    byteSize: number;
    contentHash: `sha256:${string}`;
    mimeType: ArtifactOfficeMimeType;
  }>;
  snapshot:
    | Readonly<{
        modality: "spreadsheet";
        bytes: Uint8Array;
        byteSize: number;
        contentHash: `sha256:${string}`;
        stateHash: `sha256:${string}`;
        modelSchemaVersion: typeof SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION;
        kernelVersion: string;
        coveredCausalFrontier: readonly Readonly<{ replicaId: string; counter: number }>[];
        operationProtocolVersion: typeof COMMITTED_TRANSACTION_PROTOCOL_VERSION;
        crdtStateVersion: typeof SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION;
      }>
    | Readonly<{
        modality: "document";
        bytes: Uint8Array;
        byteSize: number;
        contentHash: `sha256:${string}`;
        stateHash: `sha256:${string}`;
        modelSchemaVersion: typeof DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION;
        kernelVersion: string;
        nativeRevision: number;
      }>
    | Readonly<{
        modality: "presentation";
        bytes: Uint8Array;
        byteSize: number;
        contentHash: `sha256:${string}`;
        stateHash: `sha256:${string}`;
        modelSchemaVersion: typeof PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION;
        kernelVersion: string;
        nativeRevision: number;
      }>;
}>;

/** The Office container is valid input bytes but cannot be modeled safely. */
export class ArtifactOfficeSourceUnsupportedError extends Error {
  constructor(extension: ".xlsx" | ".docx" | ".pptx", options: ErrorOptions) {
    super(`The ${extension} source could not be imported`, options);
    this.name = "ArtifactOfficeSourceUnsupportedError";
  }
}

/** Import bounded Office bytes through the exact verified facade, without a local path. */
export async function prepareArtifactOfficeImport(
  input: Readonly<{
    facade: unknown;
    modality: ArtifactOfficeModality;
    filename: string;
    mimeType: ArtifactOfficeMimeType;
    bytes: Uint8Array;
    expectedRuntimeTarget: string;
    expectedKernelVersion: string;
  }>,
): Promise<PreparedArtifactOfficeImport> {
  const expected = officeFormat(input.modality);
  if (input.mimeType !== expected.mimeType) {
    throw new TypeError("Office MIME type does not match artifact modality");
  }
  if (!input.filename.toLowerCase().endsWith(expected.extension)) {
    throw new TypeError(`Office filename must end with ${expected.extension}`);
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1) {
    throw new TypeError("Office source bytes must be a nonempty Uint8Array");
  }
  if (input.bytes.byteLength > EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES) {
    throw new RangeError("Office source exceeds the editable artifact product limit");
  }
  const sourceBytes = Uint8Array.from(input.bytes);
  const module = exactModule(input.facade);
  const fileBlob = exactNamespace(module.FileBlob, "FileBlob");
  const fromBytes = exactFunction(fileBlob.fromBytes, "FileBlob.fromBytes");
  const createSnapshot = exactFunction(module.createArtifactSnapshot, "createArtifactSnapshot");
  const disposeArtifact = exactFunction(module.disposeArtifact, "disposeArtifact");
  const importer = officeImporter(module, input.modality);
  const blob = Reflect.apply(fromBytes, fileBlob, [
    sourceBytes,
    { name: input.filename, type: input.mimeType },
  ]);
  let artifact: unknown;
  try {
    artifact = await importer(blob);
  } catch (cause) {
    throw new ArtifactOfficeSourceUnsupportedError(expected.extension, { cause });
  }
  try {
    const snapshot = validateSnapshot(
      Reflect.apply(createSnapshot, module, [artifact]),
      input.modality,
      input.expectedRuntimeTarget,
      input.expectedKernelVersion,
    );
    return Object.freeze({
      source: Object.freeze({
        filename: input.filename,
        byteSize: sourceBytes.byteLength,
        contentHash: sha256(sourceBytes),
        mimeType: input.mimeType,
      }),
      snapshot,
    });
  } finally {
    Reflect.apply(disposeArtifact, module, [artifact]);
  }
}

function validateSnapshot(
  value: unknown,
  modality: ArtifactOfficeModality,
  expectedRuntimeTarget: string,
  expectedKernelVersion: string,
): PreparedArtifactOfficeImport["snapshot"] {
  const snapshot = exactNamespace(value, "artifact snapshot") as unknown as ArtifactSnapshot;
  const current = currentEditableArtifactCompatibility(modality);
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.modality !== modality ||
    snapshot.runtimeTarget !== expectedRuntimeTarget ||
    snapshot.kernelVersion !== expectedKernelVersion ||
    snapshot.modelSchemaVersion !== current.modelSchemaVersion ||
    snapshot.snapshotVersion !== current.snapshotVersion ||
    !/^sha256:[0-9a-f]{64}$/u.test(snapshot.stateHash)
  ) {
    throw new TypeError("Imported snapshot differs from the verified native runtime boundary");
  }
  if (
    !(snapshot.snapshotBytes instanceof Uint8Array) ||
    snapshot.snapshotBytes.byteLength < 1 ||
    snapshot.snapshotBytes.byteLength > EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES
  ) {
    throw new TypeError("Imported snapshot bytes are outside the product limit");
  }
  const bytes = Uint8Array.from(snapshot.snapshotBytes);
  const common = {
    bytes,
    byteSize: bytes.byteLength,
    contentHash: sha256(bytes),
    stateHash: snapshot.stateHash as `sha256:${string}`,
    kernelVersion: snapshot.kernelVersion,
  };
  if (snapshot.modality === "spreadsheet") {
    if (
      !(snapshot.coveredCausalFrontierBytes instanceof Uint8Array) ||
      snapshot.operationProtocolVersion !== COMMITTED_TRANSACTION_PROTOCOL_VERSION ||
      snapshot.crdtStateVersion !== SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION
    ) {
      throw new TypeError("Imported spreadsheet snapshot coverage is invalid");
    }
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      modelSchemaVersion: SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
      coveredCausalFrontier: decodeEditableArtifactCausalFrontier(
        snapshot.coveredCausalFrontierBytes,
      ),
      operationProtocolVersion: COMMITTED_TRANSACTION_PROTOCOL_VERSION,
      crdtStateVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
    });
  }
  if (!Number.isSafeInteger(snapshot.nativeRevision) || snapshot.nativeRevision < 0) {
    throw new TypeError("Imported serialized snapshot revision is invalid");
  }
  return snapshot.modality === "document"
    ? Object.freeze({
        ...common,
        modality: "document" as const,
        modelSchemaVersion: DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION,
        nativeRevision: snapshot.nativeRevision,
      })
    : Object.freeze({
        ...common,
        modality: "presentation" as const,
        modelSchemaVersion: PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION,
        nativeRevision: snapshot.nativeRevision,
      });
}

function officeImporter(
  module: Record<string, unknown>,
  modality: ArtifactOfficeModality,
): (input: unknown) => Promise<unknown> {
  const namespaceName =
    modality === "spreadsheet"
      ? "SpreadsheetFile"
      : modality === "document"
        ? "DocumentFile"
        : "PresentationFile";
  const methodName =
    modality === "spreadsheet"
      ? "importXlsx"
      : modality === "document"
        ? "importDocx"
        : "importPptx";
  const namespace = exactNamespace(module[namespaceName], namespaceName);
  const method = exactFunction(namespace[methodName], `${namespaceName}.${methodName}`);
  return async (blob) => await Reflect.apply(method, namespace, [blob]);
}

function officeFormat(modality: ArtifactOfficeModality): Readonly<{
  extension: ".xlsx" | ".docx" | ".pptx";
  mimeType: ArtifactOfficeMimeType;
}> {
  if (modality === "spreadsheet") {
    return {
      extension: ".xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (modality === "document") {
    return {
      extension: ".docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  return {
    extension: ".pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
}

function exactModule(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Verified artifact facade must be a module namespace");
  }
  return value as Record<string, unknown>;
}

function exactNamespace(value: unknown, label: string): Record<string, unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`Verified artifact facade is missing ${label}`);
  }
  return value as Record<string, unknown>;
}

function exactFunction(value: unknown, label: string): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(`Verified artifact facade is missing ${label}()`);
  }
  return value as (...args: unknown[]) => unknown;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
