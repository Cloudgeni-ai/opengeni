import { createHash } from "node:crypto";

import {
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  currentEditableArtifactCompatibility,
  decodeEditableArtifactMutationIntent,
  decodeDocumentArtifactQueryResponse,
  decodePresentationArtifactQueryResponse,
  decodeSpreadsheetArtifactKernelProjection,
  encodeDocumentArtifactCommandBatch,
  encodeDocumentArtifactQuery,
  encodePresentationArtifactCommandBatch,
  encodePresentationArtifactQuery,
  encodeSpreadsheetArtifactCommandBatch,
  encodeSpreadsheetArtifactKernelQuery,
  hashEditableArtifactMutationIntent,
  type DocumentArtifactCommand,
  type DocumentArtifactQuery,
  type PresentationArtifactCommand,
  type PresentationArtifactQuery,
  type SpreadsheetArtifactCommand,
  type SpreadsheetArtifactKernelQuery,
} from "@opengeni/contracts/editable-artifacts";

import type {
  EditableArtifactDurableExportService,
  EditableArtifactMaterializationFormat,
  EditableArtifactMaterializationJob,
} from "./durable-export";
import {
  EditableArtifactDomainError,
  EditableArtifactIdempotencyConflictError,
  EditableArtifactNotFoundError,
  EditableArtifactStaleBaseError,
} from "./errors";
import type { EditableArtifactService } from "./service";
import {
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactRequestHash,
  editableArtifactScope,
  editableArtifactStateHash,
  validateEditableArtifactActor,
  type EditableArtifact,
  type EditableArtifactActor,
  type EditableArtifactClientTransactionId,
  type EditableArtifactId,
  type EditableArtifactModality,
  type EditableArtifactOriginalImport,
  type EditableArtifactScope,
  type EditableArtifactReceipt,
  type ImportEditableArtifactRequest,
  type EditableArtifactStateHash,
} from "./types";
import type { EditableArtifactKernelState } from "./ports";

export type EditableArtifactAgentCommandBatch =
  | Readonly<{ modality: "spreadsheet"; commands: readonly SpreadsheetArtifactCommand[] }>
  | Readonly<{ modality: "document"; commands: readonly DocumentArtifactCommand[] }>
  | Readonly<{ modality: "presentation"; commands: readonly PresentationArtifactCommand[] }>;

export type EditableArtifactAgentQuery =
  | Readonly<{ modality: "spreadsheet"; query: SpreadsheetArtifactKernelQuery }>
  | Readonly<{ modality: "document"; query: DocumentArtifactQuery }>
  | Readonly<{ modality: "presentation"; query: PresentationArtifactQuery }>;

export type EditableArtifactAgentContext = Readonly<{
  scope: EditableArtifactScope;
  actor: EditableArtifactActor;
  sessionId: string;
}>;

export type EditableArtifactAgentMetadata = Readonly<{
  id: string;
  modality: EditableArtifactModality;
  title: string;
  lifecycle: EditableArtifact["lifecycle"];
  headSequence: number;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}>;

export type EditableArtifactAgentMutationReceipt = Readonly<{
  artifact: EditableArtifactAgentMetadata;
  transaction: Readonly<{
    id: string;
    clientTransactionId: string;
    sequenceStart: number;
    sequenceEnd: number;
    stateHash: string;
    committedAt: string;
    replayed: boolean;
  }>;
}>;

export type EditableArtifactAgentExportReceipt = Readonly<{
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  artifactId: string;
  versionId: string;
  materializationJobId: string;
  sourceHeadSequence: number;
  sourceStateHash: string;
}>;

export type PreparedEditableArtifactImport = Readonly<{
  originalImport: EditableArtifactOriginalImport;
  snapshot: ImportEditableArtifactRequest["snapshot"];
}>;

export type EditableArtifactOfficeImportErrorCode =
  | "invalid_source"
  | "source_changed"
  | "unsupported_content";

export class EditableArtifactOfficeImportError extends Error {
  constructor(readonly code: EditableArtifactOfficeImportErrorCode) {
    super(code);
    this.name = "EditableArtifactOfficeImportError";
  }
}

export interface EditableArtifactAgentAssociationPort {
  listArtifactIds(input: {
    scope: EditableArtifactScope;
    sessionId: string;
    limit: number;
  }): Promise<readonly EditableArtifactId[]>;
  touch(input: {
    scope: EditableArtifactScope;
    sessionId: string;
    artifactId: EditableArtifactId;
  }): Promise<void>;
}

export interface EditableArtifactAgentInspectionKernelPort {
  query(input: { state: EditableArtifactKernelState; queryBytes: Uint8Array }): Promise<Uint8Array>;
}

export interface EditableArtifactOfficeImportPort {
  prepare(input: {
    scope: EditableArtifactScope;
    actor: EditableArtifactActor;
    fileId: string;
    modality: EditableArtifactModality;
    signal?: AbortSignal;
  }): Promise<PreparedEditableArtifactImport>;
}

export interface EditableArtifactAgentWorkspaceFilePort {
  ensureMaterializationFile(input: {
    scope: EditableArtifactScope;
    actor: EditableArtifactActor;
    artifact: EditableArtifact;
    versionId: string;
    jobId: string;
    filename: string;
    sourceHeadSequence: number;
    sourceStateHash: string;
    signal?: AbortSignal;
  }): Promise<EditableArtifactAgentExportReceipt>;
}

export type EditableArtifactAgentApplicationDependencies = Readonly<{
  domain: EditableArtifactService;
  exports: EditableArtifactDurableExportService;
  associations: EditableArtifactAgentAssociationPort;
  inspector: EditableArtifactAgentInspectionKernelPort;
  officeImports: EditableArtifactOfficeImportPort;
  workspaceFiles: EditableArtifactAgentWorkspaceFilePort;
}>;

/**
 * Attempt-neutral use cases shared by direct model tools and Codemode. This is
 * not another artifact engine: every mutation terminates at EditableArtifactService.
 */
export class EditableArtifactAgentApplication {
  constructor(private readonly dependencies: EditableArtifactAgentApplicationDependencies) {}

  async list(
    input: EditableArtifactAgentContext & Readonly<{ limit?: number }>,
  ): Promise<readonly EditableArtifactAgentMetadata[]> {
    const context = agentContext(input);
    const limit = boundedLimit(input.limit ?? 64);
    const ids = await this.dependencies.associations.listArtifactIds({
      scope: context.scope,
      sessionId: context.sessionId,
      limit,
    });
    const artifacts: EditableArtifactAgentMetadata[] = [];
    for (const artifactId of ids) {
      try {
        const artifact = await this.dependencies.domain.getArtifact({
          scope: context.scope,
          actor: context.actor,
          artifactId,
        });
        artifacts.push(projectArtifact(artifact));
      } catch (error) {
        if (
          error instanceof EditableArtifactNotFoundError ||
          (error instanceof EditableArtifactDomainError && error.code === "forbidden")
        ) {
          continue;
        }
        throw error;
      }
    }
    return Object.freeze(artifacts);
  }

  async create(
    input: EditableArtifactAgentContext &
      Readonly<{
        idempotencyKey: EditableArtifactClientTransactionId;
        modality: EditableArtifactModality;
        title: string;
        signal?: AbortSignal;
      }>,
  ): Promise<EditableArtifactAgentMetadata> {
    const context = agentContext(input);
    const result = await this.dependencies.domain.createArtifact({
      scope: context.scope,
      actor: context.actor,
      request: {
        idempotencyKey: editableArtifactClientTransactionId(input.idempotencyKey),
        modality: input.modality,
        title: input.title,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await this.touch(context, result.artifact.id);
    return projectArtifact(result.artifact);
  }

  async import(
    input: EditableArtifactAgentContext &
      Readonly<{
        idempotencyKey: EditableArtifactClientTransactionId;
        fileId: string;
        modality: EditableArtifactModality;
        title: string;
        signal?: AbortSignal;
      }>,
  ): Promise<EditableArtifactAgentMetadata> {
    const context = agentContext(input);
    const prepared = await this.dependencies.officeImports.prepare({
      scope: context.scope,
      actor: context.actor,
      fileId: input.fileId,
      modality: input.modality,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const result = await this.dependencies.domain.importArtifact({
      scope: context.scope,
      actor: context.actor,
      request: {
        idempotencyKey: editableArtifactClientTransactionId(input.idempotencyKey),
        modality: input.modality,
        title: input.title,
        originalImport: prepared.originalImport,
        snapshot: prepared.snapshot,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await this.touch(context, result.artifact.id);
    return projectArtifact(result.artifact);
  }

  async get(
    input: EditableArtifactAgentContext & Readonly<{ artifactId: EditableArtifactId }>,
  ): Promise<EditableArtifactAgentMetadata> {
    const context = agentContext(input);
    const artifact = await this.dependencies.domain.getArtifact({
      scope: context.scope,
      actor: context.actor,
      artifactId: editableArtifactId(input.artifactId),
    });
    await this.touch(context, artifact.id);
    return projectArtifact(artifact);
  }

  async inspect(
    input: EditableArtifactAgentContext &
      Readonly<{ artifactId: EditableArtifactId; request: EditableArtifactAgentQuery }>,
  ): Promise<Readonly<{ artifact: EditableArtifactAgentMetadata; projection: unknown }>> {
    const context = agentContext(input);
    const artifactId = editableArtifactId(input.artifactId);
    const state = await this.dependencies.domain.readCurrentKernelState({
      scope: context.scope,
      actor: context.actor,
      artifactId,
    });
    if (state.modality !== input.request.modality)
      throw new TypeError("Artifact modality mismatch");
    const queryBytes = encodeQuery(input.request);
    const responseBytes = await this.dependencies.inspector.query({ state, queryBytes });
    const projection = decodeQueryResponse(input.request.modality, responseBytes);
    await this.touch(context, artifactId);
    return Object.freeze({ artifact: projectArtifact(state.artifact), projection });
  }

  async apply(
    input: EditableArtifactAgentContext &
      Readonly<{
        artifactId: EditableArtifactId;
        clientTransactionId: EditableArtifactClientTransactionId;
        expectedHeadSequence: number;
        expectedStateHash: string;
        batch: EditableArtifactAgentCommandBatch;
      }>,
  ): Promise<EditableArtifactAgentMutationReceipt> {
    const context = agentContext(input);
    const artifactId = editableArtifactId(input.artifactId);
    const commandBytes = encodeCommands(input.batch);
    const clientTransactionId = editableArtifactClientTransactionId(input.clientTransactionId);
    const expectedHeadSequence = boundedHeadSequence(input.expectedHeadSequence);
    const expectedStateHash = editableArtifactStateHash(input.expectedStateHash);
    const artifact = await this.dependencies.domain.getArtifact({
      scope: context.scope,
      actor: context.actor,
      artifactId,
    });
    if (artifact.modality !== input.batch.modality)
      throw new TypeError("Artifact modality mismatch");
    if (
      artifact.headSequence !== expectedHeadSequence ||
      artifact.stateHash !== expectedStateHash
    ) {
      const existing = await this.dependencies.domain.findTransactionReceipt({
        scope: context.scope,
        actor: context.actor,
        artifactId,
        clientTransactionId,
      });
      if (existing) {
        if (
          !receiptMatchesAgentMutation(
            existing,
            expectedHeadSequence,
            expectedStateHash,
            commandBytes,
          )
        ) {
          throw new EditableArtifactIdempotencyConflictError();
        }
        await this.touch(context, artifactId);
        return Object.freeze({
          artifact: projectArtifact(artifact),
          transaction: projectReceipt(existing, true),
        });
      }
      throw new EditableArtifactStaleBaseError();
    }
    const authored = hashEditableArtifactMutationIntent({
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion: EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION,
      modelSchemaVersion: currentEditableArtifactCompatibility(input.batch.modality)
        .modelSchemaVersion,
      commandProtocolVersion: commandProtocolVersion(input.batch.modality),
      artifactId,
      clientTransactionId,
      replicaId: context.actor.replicaId,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: expectedHeadSequence,
      causalBase: artifact.modality === "spreadsheet" ? artifact.causalFrontier : [],
      selectiveUndoOperationIds: [],
      commandBytes,
    });
    let applied: Awaited<ReturnType<EditableArtifactService["applyTransaction"]>>;
    try {
      applied = await this.dependencies.domain.applyTransaction({
        scope: context.scope,
        actor: context.actor,
        artifactId,
        request: {
          intentBytes: authored.bytes,
          requestHash: editableArtifactRequestHash(authored.requestHash),
          expectedHead: Object.freeze({
            sequence: expectedHeadSequence,
            stateHash: expectedStateHash,
          }),
        },
      });
    } catch (error) {
      if (!(error instanceof EditableArtifactIdempotencyConflictError)) throw error;
      const receipt = await this.dependencies.domain.findTransactionReceipt({
        scope: context.scope,
        actor: context.actor,
        artifactId,
        clientTransactionId,
      });
      if (
        !receipt ||
        !receiptMatchesAgentMutation(receipt, expectedHeadSequence, expectedStateHash, commandBytes)
      ) {
        throw error;
      }
      applied = Object.freeze({ receipt, replayed: true });
    }
    const current = await this.dependencies.domain.getArtifact({
      scope: context.scope,
      actor: context.actor,
      artifactId,
    });
    await this.touch(context, artifactId);
    return Object.freeze({
      artifact: projectArtifact(current),
      transaction: projectReceipt(applied.receipt, applied.replayed),
    });
  }

  async startExport(
    input: EditableArtifactAgentContext &
      Readonly<{
        artifactId: EditableArtifactId;
        idempotencyKey: string;
        format: EditableArtifactMaterializationFormat;
        options?: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
      }>,
  ): Promise<
    Readonly<{
      artifact: EditableArtifactAgentMetadata;
      versionId: string;
      jobId: string;
      sourceHeadSequence: number;
      sourceStateHash: string;
      state: EditableArtifactMaterializationJob["state"];
    }>
  > {
    const context = agentContext(input);
    const artifactId = editableArtifactId(input.artifactId);
    const artifact = await this.dependencies.domain.getArtifact({
      scope: context.scope,
      actor: context.actor,
      artifactId,
    });
    const version = await this.dependencies.exports.pinVersion({
      scope: context.scope,
      actor: context.actor,
      artifactId,
      idempotencyKey: exportChildIdempotencyKey(input.idempotencyKey, "version"),
      name: `Export ${artifact.title}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const materialization = await this.dependencies.exports.enqueueMaterialization({
      scope: context.scope,
      actor: context.actor,
      artifactId,
      idempotencyKey: exportChildIdempotencyKey(input.idempotencyKey, "materialization"),
      versionId: version.version.id,
      format: input.format,
      ...(input.options ? { options: input.options } : {}),
    });
    const current = await this.dependencies.domain.getArtifact({
      scope: context.scope,
      actor: context.actor,
      artifactId,
    });
    await this.touch(context, artifactId);
    return Object.freeze({
      artifact: projectArtifact(current),
      versionId: version.version.id,
      jobId: materialization.job.id,
      sourceHeadSequence: materialization.job.targetHeadSequence,
      sourceStateHash: materialization.job.stateHash,
      state: materialization.job.state,
    });
  }

  async exportStatus(
    input: EditableArtifactAgentContext &
      Readonly<{
        artifactId: EditableArtifactId;
        versionId: string;
        jobId: string;
        signal?: AbortSignal;
      }>,
  ): Promise<
    Readonly<{
      artifact: EditableArtifactAgentMetadata;
      versionId: string;
      jobId: string;
      sourceHeadSequence: number;
      sourceStateHash: string;
      state: EditableArtifactMaterializationJob["state"];
      errorCode: string | null;
      file: EditableArtifactAgentExportReceipt | null;
    }>
  > {
    const context = agentContext(input);
    const artifactId = editableArtifactId(input.artifactId);
    const artifact = await this.dependencies.domain.getArtifact({
      scope: context.scope,
      actor: context.actor,
      artifactId,
    });
    const job = await this.dependencies.exports.getMaterialization({
      scope: context.scope,
      actor: context.actor,
      artifactId,
      jobId: input.jobId,
    });
    if (job.versionId !== input.versionId) throw new TypeError("Export version mismatch");
    const file =
      job.state === "succeeded" && job.result
        ? await this.dependencies.workspaceFiles.ensureMaterializationFile({
            scope: context.scope,
            actor: context.actor,
            artifact,
            versionId: job.versionId,
            jobId: job.id,
            filename: defaultExportFilename(artifact.title, job.format),
            sourceHeadSequence: job.targetHeadSequence,
            sourceStateHash: job.stateHash,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : null;
    await this.touch(context, artifactId);
    return Object.freeze({
      artifact: projectArtifact(artifact),
      versionId: job.versionId,
      jobId: job.id,
      sourceHeadSequence: job.targetHeadSequence,
      sourceStateHash: job.stateHash,
      state: job.state,
      errorCode: job.errorCode,
      file,
    });
  }

  private async touch(context: EditableArtifactAgentContext, artifactId: EditableArtifactId) {
    await this.dependencies.associations.touch({
      scope: context.scope,
      sessionId: context.sessionId,
      artifactId,
    });
  }
}

function agentContext(input: EditableArtifactAgentContext): EditableArtifactAgentContext {
  const scope = editableArtifactScope(input.scope);
  validateEditableArtifactActor(input.actor);
  if (input.actor.kind !== "agent" || input.actor.sessionId !== input.sessionId) {
    throw new TypeError("Artifact agent context is not bound to its attempt session");
  }
  return Object.freeze({
    scope,
    actor: Object.freeze({ ...input.actor }) as EditableArtifactActor,
    sessionId: boundedSessionId(input.sessionId),
  });
}

function encodeCommands(batch: EditableArtifactAgentCommandBatch): Uint8Array {
  if (batch.modality === "spreadsheet") {
    return encodeSpreadsheetArtifactCommandBatch({
      version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
      commands: batch.commands,
    });
  }
  if (batch.modality === "document") {
    return encodeDocumentArtifactCommandBatch({
      version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
      commands: batch.commands,
    });
  }
  return encodePresentationArtifactCommandBatch({
    version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
    commands: batch.commands,
  });
}

function encodeQuery(request: EditableArtifactAgentQuery): Uint8Array {
  if (request.modality === "spreadsheet") {
    return encodeSpreadsheetArtifactKernelQuery(request.query);
  }
  if (request.modality === "document") return encodeDocumentArtifactQuery(request.query);
  return encodePresentationArtifactQuery(request.query);
}

function decodeQueryResponse(modality: EditableArtifactModality, bytes: Uint8Array): unknown {
  if (modality === "spreadsheet") return decodeSpreadsheetArtifactKernelProjection(bytes);
  if (modality === "document") return decodeDocumentArtifactQueryResponse(bytes);
  return decodePresentationArtifactQueryResponse(bytes);
}

function commandProtocolVersion(modality: EditableArtifactModality): number {
  if (modality === "spreadsheet") return SPREADSHEET_ARTIFACT_COMMAND_VERSION;
  if (modality === "document") return DOCUMENT_ARTIFACT_COMMAND_VERSION;
  return PRESENTATION_ARTIFACT_COMMAND_VERSION;
}

function projectArtifact(artifact: EditableArtifact): EditableArtifactAgentMetadata {
  return Object.freeze({
    id: artifact.id,
    modality: artifact.modality,
    title: artifact.title,
    lifecycle: artifact.lifecycle,
    headSequence: artifact.headSequence,
    stateHash: artifact.stateHash,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  });
}

function projectReceipt(
  receipt: EditableArtifactReceipt,
  replayed: boolean,
): EditableArtifactAgentMutationReceipt["transaction"] {
  return Object.freeze({
    id: receipt.serverTransactionId,
    clientTransactionId: receipt.clientTransactionId,
    sequenceStart: receipt.sequenceStart,
    sequenceEnd: receipt.sequenceEnd,
    stateHash: receipt.stateHash,
    committedAt: receipt.committedAt,
    replayed,
  });
}

function receiptMatchesAgentMutation(
  receipt: EditableArtifactReceipt,
  expectedHeadSequence: number,
  expectedStateHash: EditableArtifactStateHash,
  commandBytes: Uint8Array,
): boolean {
  const intent = decodeEditableArtifactMutationIntent(receipt.intentBytes);
  return (
    intent.observedHeadSequence === expectedHeadSequence &&
    receipt.priorStateHash === expectedStateHash &&
    sameBytes(commandBytes, intent.commandBytes)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function boundedSessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError("Artifact session id is invalid");
  }
  return value;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new TypeError("Artifact list limit must be between 1 and 64");
  }
  return value;
}

function boundedHeadSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Artifact expected head sequence must be a nonnegative safe integer");
  }
  return value;
}

function defaultExportFilename(title: string, format: string): string {
  const stem = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  return `${stem || "artifact"}.${format}`;
}

function exportChildIdempotencyKey(
  value: string,
  operation: "version" | "materialization",
): string {
  const digest = createHash("sha256")
    .update("opengeni:editable-artifact-export:v1\0", "utf8")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `artifact-export:${operation}:${digest}`;
}
