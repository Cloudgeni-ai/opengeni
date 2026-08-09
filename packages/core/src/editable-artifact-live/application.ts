import type { EditableArtifactService } from "../domain/editable-artifacts/service";
import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";
import {
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactScope,
  validateEditableArtifactActor,
  type EditableArtifact,
  type EditableArtifactActor,
  type EditableArtifactClientTransactionId,
  type EditableArtifactId,
  type EditableArtifactModality,
  type EditableArtifactOriginalImport,
  type EditableArtifactScope,
  type ImportEditableArtifactRequest,
} from "../domain/editable-artifacts/types";
import type {
  EditableArtifactLiveSession,
  EditableArtifactLiveServer,
  OpenEditableArtifactLiveInput,
} from "./server";
import type { EditableArtifactLiveTicket } from "./types";

export type EditableArtifactLiveCompatibilityRequest = Readonly<{
  artifact: EditableArtifact;
  protocolVersion: number;
  kernelVersion: string;
  modelSchemaVersion: number;
}>;

/** A client/runtime protocol tuple cannot be served by the loaded kernel. */
export class EditableArtifactCompatibilityError extends Error {
  readonly code = "unsupported_protocol" as const;

  constructor(message = "Editable artifact runtime is incompatible") {
    super(message);
    this.name = "EditableArtifactCompatibilityError";
  }
}

/** Local runtime compatibility; unsupported native/WASM assets fail closed. */
export interface EditableArtifactLiveCompatibilityPort {
  assertCompatible(input: EditableArtifactLiveCompatibilityRequest): Promise<void> | void;
}

export type CreateEditableArtifactApplicationInput = Readonly<{
  scope: EditableArtifactScope;
  actor: EditableArtifactActor;
  idempotencyKey: EditableArtifactClientTransactionId;
  modality: EditableArtifactModality;
  title: string;
  signal?: AbortSignal;
}>;

export type ImportEditableArtifactApplicationInput = Readonly<{
  scope: EditableArtifactScope;
  actor: EditableArtifactActor;
  idempotencyKey: EditableArtifactClientTransactionId;
  modality: EditableArtifactModality;
  title: string;
  originalImport: EditableArtifactOriginalImport;
  snapshot: ImportEditableArtifactRequest["snapshot"];
  signal?: AbortSignal;
}>;

export type ReadEditableArtifactApplicationInput = Readonly<{
  scope: EditableArtifactScope;
  actor: EditableArtifactActor;
  artifactId: EditableArtifactId;
}>;

export type MintEditableArtifactApplicationTicketInput = ReadEditableArtifactApplicationInput &
  Readonly<{
    protocolVersion: number;
    kernelVersion: string;
    modelSchemaVersion: number;
    allowEdit: boolean;
  }>;

/** Exact application seam used by standalone API and embedding hosts. */
export interface EditableArtifactApplicationPort {
  createArtifact(input: CreateEditableArtifactApplicationInput): Promise<EditableArtifact>;
  importArtifact(input: ImportEditableArtifactApplicationInput): Promise<EditableArtifact>;
  readArtifact(input: ReadEditableArtifactApplicationInput): Promise<EditableArtifact>;
  mintLiveTicket(
    input: MintEditableArtifactApplicationTicketInput,
  ): Promise<EditableArtifactLiveTicket>;
  openLive(input: OpenEditableArtifactLiveInput): Promise<EditableArtifactLiveSession>;
}

export class EditableArtifactApplication implements EditableArtifactApplicationPort {
  constructor(
    private readonly dependencies: Readonly<{
      domain: EditableArtifactService;
      live: EditableArtifactLiveServer;
      compatibility: EditableArtifactLiveCompatibilityPort;
    }>,
  ) {}

  async createArtifact(input: CreateEditableArtifactApplicationInput): Promise<EditableArtifact> {
    const scope = editableArtifactScope(input.scope);
    validateEditableArtifactActor(input.actor);
    const result = await this.dependencies.domain.createArtifact({
      scope,
      actor: Object.freeze({ ...input.actor }) as EditableArtifactActor,
      request: {
        idempotencyKey: editableArtifactClientTransactionId(input.idempotencyKey),
        modality: input.modality,
        title: input.title,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return result.artifact;
  }

  async importArtifact(input: ImportEditableArtifactApplicationInput): Promise<EditableArtifact> {
    const scope = editableArtifactScope(input.scope);
    validateEditableArtifactActor(input.actor);
    const result = await this.dependencies.domain.importArtifact({
      scope,
      actor: Object.freeze({ ...input.actor }) as EditableArtifactActor,
      request: {
        idempotencyKey: editableArtifactClientTransactionId(input.idempotencyKey),
        modality: input.modality,
        title: input.title,
        originalImport: input.originalImport,
        snapshot: input.snapshot,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return result.artifact;
  }

  async readArtifact(input: ReadEditableArtifactApplicationInput): Promise<EditableArtifact> {
    const scope = editableArtifactScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    validateEditableArtifactActor(input.actor);
    return await this.dependencies.domain.getArtifact({
      scope,
      artifactId,
      actor: Object.freeze({ ...input.actor }) as EditableArtifactActor,
    });
  }

  async mintLiveTicket(
    input: MintEditableArtifactApplicationTicketInput,
  ): Promise<EditableArtifactLiveTicket> {
    const artifact = await this.readArtifact(input);
    await this.dependencies.compatibility.assertCompatible({
      artifact,
      protocolVersion: positiveInteger(input.protocolVersion, "protocolVersion"),
      kernelVersion: boundedVersion(input.kernelVersion, "kernelVersion"),
      modelSchemaVersion: positiveInteger(input.modelSchemaVersion, "modelSchemaVersion"),
    });
    return await this.dependencies.live.mintTicket({
      scope: artifact.scope,
      artifactId: artifact.id,
      modality: artifact.modality,
      actor: input.actor,
      allowEdit: input.allowEdit,
    });
  }

  openLive(input: OpenEditableArtifactLiveInput): Promise<EditableArtifactLiveSession> {
    return this.dependencies.live.openLive(input);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedVersion(value: string, label: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES || value.trim() !== value) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
}
