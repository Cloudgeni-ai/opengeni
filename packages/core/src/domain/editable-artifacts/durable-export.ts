import { createHash } from "node:crypto";

import type { BoundedObjectRead, BoundedObjectReadPort } from "@opengeni/storage";

import type { EditableArtifactAuthorizationPort } from "./ports";
import {
  assertIsoTimestamp,
  editableArtifactActorKey,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactScope,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  validateEditableArtifactActor,
  type EditableArtifactActor,
  type EditableArtifactCausalFrontier,
  type EditableArtifactContentHash,
  type EditableArtifactId,
  type EditableArtifactModality,
  type EditableArtifactScope,
  type EditableArtifactSnapshotMetadata,
  type EditableArtifactStateHash,
} from "./types";

export const EDITABLE_ARTIFACT_EXPORT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const EDITABLE_ARTIFACT_EXPORT_MAX_OPTIONS_BYTES = 256 * 1024;

export type EditableArtifactMaterializationFormat =
  | "xlsx"
  | "pptx"
  | "docx"
  | "pdf"
  | "png"
  | "webp";

export type EditableArtifactMaterializationMimeType =
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/pdf"
  | "image/png"
  | "image/webp";

export type EditableArtifactPinnedVersion = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  id: string;
  modality: EditableArtifactModality;
  snapshotId: string;
  headSequence: number;
  causalFrontier: EditableArtifactCausalFrontier | null;
  nativeRevision: number | null;
  stateHash: EditableArtifactStateHash;
  name: string;
  pinned: true;
  createdBySubjectId: string;
  createdAt: string;
}>;

export type EditableArtifactMaterializationResult = Readonly<{
  id: string;
  byteSize: number;
  contentHash: EditableArtifactContentHash;
  mimeType: EditableArtifactMaterializationMimeType;
  verifiedAt: string;
  createdAt: string;
}>;

export type EditableArtifactMaterializationJob = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  id: string;
  versionId: string;
  inputSnapshotId: string;
  targetHeadSequence: number;
  stateHash: EditableArtifactStateHash;
  format: EditableArtifactMaterializationFormat;
  state: "pending" | "running" | "succeeded" | "failed";
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: EditableArtifactMaterializationResult | null;
}>;

export type EditableArtifactMaterializationProfile = Readonly<{
  modality: EditableArtifactModality;
  format: EditableArtifactMaterializationFormat;
  codecId: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
  /** Canonical JSON object understood by the pinned native materializer. */
  normalizedOptions: string;
}>;

/** Server-owned profile lookup. Clients never supply executable identity facts. */
export interface EditableArtifactMaterializationProfilePort {
  resolve(
    input: Readonly<{
      modality: EditableArtifactModality;
      format: EditableArtifactMaterializationFormat;
      options: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<EditableArtifactMaterializationProfile | null>;
}

export interface EditableArtifactDurableExportIdFactoryPort {
  next(kind: "version" | "materialization_job" | "receipt"): string;
}

export interface EditableArtifactExactSnapshotPort {
  ensure(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      actor: EditableArtifactActor;
      signal?: AbortSignal;
    }>,
  ): Promise<EditableArtifactSnapshotMetadata>;
}

type DurableExportContext = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  actor: EditableArtifactActor;
}>;

export type PinEditableArtifactVersionStoreRequest = DurableExportContext &
  Readonly<{
    expectedAuthorizationRevision: number;
    authorityKey: string;
    receiptId: string;
    versionId: string;
    idempotencyKey: string;
    requestHash: string;
    name: string;
    snapshot: EditableArtifactSnapshotMetadata;
  }>;

export type PinEditableArtifactVersionStoreResult =
  | Readonly<{ kind: "result"; version: EditableArtifactPinnedVersion; replayed: boolean }>
  | Readonly<{ kind: "authorization_stale" }>;

export type EnqueueEditableArtifactMaterializationStoreRequest = DurableExportContext &
  Readonly<{
    expectedAuthorizationRevision: number;
    authorityKey: string;
    receiptId: string;
    jobId: string;
    idempotencyKey: string;
    requestHash: string;
    versionId: string;
    profile: EditableArtifactMaterializationProfile;
  }>;

export type EnqueueEditableArtifactMaterializationStoreResult =
  | Readonly<{
      kind: "result";
      job: EditableArtifactMaterializationJob;
      replayed: boolean;
    }>
  | Readonly<{ kind: "authorization_stale" }>;

export type ReadEditableArtifactMaterializationStoreResult =
  | Readonly<{ kind: "result"; job: EditableArtifactMaterializationJob | null }>
  | Readonly<{ kind: "authorization_stale" }>;

export type ReadEditableArtifactVersionStoreResult =
  | Readonly<{ kind: "result"; version: EditableArtifactPinnedVersion | null }>
  | Readonly<{ kind: "authorization_stale" }>;

export type ReadEditableArtifactMaterializationDownloadStoreResult =
  | Readonly<{
      kind: "result";
      job: EditableArtifactMaterializationJob | null;
      objectReference: string | null;
    }>
  | Readonly<{ kind: "authorization_stale" }>;

export interface EditableArtifactDurableExportStorePort {
  pinVersion(
    input: PinEditableArtifactVersionStoreRequest,
  ): Promise<PinEditableArtifactVersionStoreResult>;
  enqueueMaterialization(
    input: EnqueueEditableArtifactMaterializationStoreRequest,
  ): Promise<EnqueueEditableArtifactMaterializationStoreResult>;
  readVersion(
    input: DurableExportContext &
      Readonly<{ expectedAuthorizationRevision: number; versionId: string }>,
  ): Promise<ReadEditableArtifactVersionStoreResult>;
  readMaterialization(
    input: DurableExportContext &
      Readonly<{ expectedAuthorizationRevision: number; jobId: string }>,
  ): Promise<ReadEditableArtifactMaterializationStoreResult>;
  readMaterializationDownload(
    input: DurableExportContext &
      Readonly<{ expectedAuthorizationRevision: number; jobId: string }>,
  ): Promise<ReadEditableArtifactMaterializationDownloadStoreResult>;
}

export type EditableArtifactMaterializationDownload = Readonly<{
  artifactId: EditableArtifactId;
  jobId: string;
  format: EditableArtifactMaterializationFormat;
  byteSize: number;
  contentHash: EditableArtifactContentHash;
  mimeType: EditableArtifactMaterializationMimeType;
  chunks(input?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  assertUnchanged(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

export type EditableArtifactDurableExportErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "unsupported_format"
  | "not_ready"
  | "unavailable";

export class EditableArtifactDurableExportError extends Error {
  constructor(readonly code: EditableArtifactDurableExportErrorCode) {
    super(code);
    this.name = "EditableArtifactDurableExportError";
  }
}

export type EditableArtifactDurableExportServiceDependencies = Readonly<{
  authorization: EditableArtifactAuthorizationPort;
  exactSnapshots: EditableArtifactExactSnapshotPort;
  store: EditableArtifactDurableExportStorePort;
  ids: EditableArtifactDurableExportIdFactoryPort;
  profiles: EditableArtifactMaterializationProfilePort;
  materializationObjects: BoundedObjectReadPort;
}>;

const MAX_AUTHORIZATION_RETRIES = 4;
const PORTABLE_ID = /^[0-9a-f]{32}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROFILE_TEXT = /^[\x21-\x7e]+$/u;

export class EditableArtifactDurableExportService {
  constructor(private readonly dependencies: EditableArtifactDurableExportServiceDependencies) {}

  async pinVersion(
    input: DurableExportContext & {
      idempotencyKey: string;
      name: string;
      signal?: AbortSignal;
    },
  ): Promise<{ version: EditableArtifactPinnedVersion; replayed: boolean }> {
    const context = normalizeContext(input);
    const idempotencyKey = portableIdempotencyKey(input.idempotencyKey);
    const name = versionName(input.name);
    const snapshot = await this.dependencies.exactSnapshots.ensure({
      ...context,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      snapshot.scope.accountId !== context.scope.accountId ||
      snapshot.scope.workspaceId !== context.scope.workspaceId ||
      snapshot.artifactId !== context.artifactId
    ) {
      throw new EditableArtifactDurableExportError("unavailable");
    }
    const requestHash = hashPublicRequest("pin-version", [idempotencyKey, name]);
    const authorityKey = editableArtifactActorKey(context.actor);
    const receiptId = stableId(this.dependencies.ids.next("receipt"), "receipt id");
    const versionId = stableId(this.dependencies.ids.next("version"), "version id");

    for (let attempt = 0; attempt < MAX_AUTHORIZATION_RETRIES; attempt += 1) {
      const revision = await this.requireExportPermission(context);
      const result = await this.dependencies.store.pinVersion({
        ...context,
        expectedAuthorizationRevision: revision,
        authorityKey,
        receiptId,
        versionId,
        idempotencyKey,
        requestHash,
        name,
        snapshot,
      });
      if (result.kind === "result") {
        return Object.freeze({ version: result.version, replayed: result.replayed });
      }
    }
    throw new EditableArtifactDurableExportError("conflict");
  }

  async enqueueMaterialization(
    input: DurableExportContext & {
      idempotencyKey: string;
      versionId: string;
      format: EditableArtifactMaterializationFormat;
      options?: Readonly<Record<string, unknown>>;
    },
  ): Promise<{ job: EditableArtifactMaterializationJob; replayed: boolean }> {
    const context = normalizeContext(input);
    const idempotencyKey = portableIdempotencyKey(input.idempotencyKey);
    const versionId = stableId(input.versionId, "version id");
    const format = materializationFormat(input.format);
    const options = exactOptions(input.options ?? Object.freeze({}));
    const version = await this.getVersion(context, versionId);
    const profile = await this.dependencies.profiles.resolve({
      modality: version.modality,
      format,
      options,
    });
    if (!profile) throw new EditableArtifactDurableExportError("unsupported_format");
    validateProfile(profile, version.modality, format);
    const requestHash = hashPublicRequest("materialize", [
      idempotencyKey,
      versionId,
      format,
      canonicalJson(options),
    ]);
    const authorityKey = editableArtifactActorKey(context.actor);
    const receiptId = stableId(this.dependencies.ids.next("receipt"), "receipt id");
    const jobId = stableId(this.dependencies.ids.next("materialization_job"), "job id");

    for (let attempt = 0; attempt < MAX_AUTHORIZATION_RETRIES; attempt += 1) {
      const revision = await this.requireExportPermission(context);
      const result = await this.dependencies.store.enqueueMaterialization({
        ...context,
        expectedAuthorizationRevision: revision,
        authorityKey,
        receiptId,
        jobId,
        idempotencyKey,
        requestHash,
        versionId,
        profile,
      });
      if (result.kind === "result") {
        return Object.freeze({ job: result.job, replayed: result.replayed });
      }
    }
    throw new EditableArtifactDurableExportError("conflict");
  }

  async getMaterialization(
    input: DurableExportContext & Readonly<{ jobId: string }>,
  ): Promise<EditableArtifactMaterializationJob> {
    const context = normalizeContext(input);
    const jobId = stableId(input.jobId, "job id");
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_RETRIES; attempt += 1) {
      const revision = await this.requireExportPermission(context);
      const result = await this.dependencies.store.readMaterialization({
        ...context,
        expectedAuthorizationRevision: revision,
        jobId,
      });
      if (result.kind === "authorization_stale") continue;
      if (!result.job) throw new EditableArtifactDurableExportError("not_found");
      return result.job;
    }
    throw new EditableArtifactDurableExportError("conflict");
  }

  async openMaterializationDownload(
    input: DurableExportContext & Readonly<{ jobId: string; signal?: AbortSignal }>,
  ): Promise<EditableArtifactMaterializationDownload> {
    const context = normalizeContext(input);
    const jobId = stableId(input.jobId, "job id");
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_RETRIES; attempt += 1) {
      const revision = await this.requireExportPermission(context);
      const result = await this.dependencies.store.readMaterializationDownload({
        ...context,
        expectedAuthorizationRevision: revision,
        jobId,
      });
      if (result.kind === "authorization_stale") continue;
      if (!result.job) throw new EditableArtifactDurableExportError("not_found");
      const materialization = result.job.result;
      if (result.job.state !== "succeeded" || !materialization || !result.objectReference) {
        throw new EditableArtifactDurableExportError("not_ready");
      }
      let object: BoundedObjectRead;
      try {
        object = await this.dependencies.materializationObjects.open({
          opaqueReference: result.objectReference,
          maxBytes: EDITABLE_ARTIFACT_EXPORT_MAX_DOWNLOAD_BYTES,
          expectedByteSize: materialization.byteSize,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        throw new EditableArtifactDurableExportError("unavailable");
      }
      if (object.contentType !== undefined && object.contentType !== materialization.mimeType) {
        await object.close();
        throw new EditableArtifactDurableExportError("unavailable");
      }
      return Object.freeze({
        artifactId: context.artifactId,
        jobId,
        format: result.job.format,
        byteSize: materialization.byteSize,
        contentHash: materialization.contentHash,
        mimeType: materialization.mimeType,
        chunks: (chunkInput: { signal?: AbortSignal } = {}) =>
          object.chunks(chunkInput.signal ? { signal: chunkInput.signal } : {}),
        assertUnchanged: async (signal?: AbortSignal) => await object.assertUnchanged(signal),
        close: async () => await object.close(),
      });
    }
    throw new EditableArtifactDurableExportError("conflict");
  }

  private async getVersion(
    context: DurableExportContext,
    versionId: string,
  ): Promise<EditableArtifactPinnedVersion> {
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_RETRIES; attempt += 1) {
      const revision = await this.requireExportPermission(context);
      const result = await this.dependencies.store.readVersion({
        ...context,
        expectedAuthorizationRevision: revision,
        versionId,
      });
      if (result.kind === "authorization_stale") continue;
      if (!result.version) throw new EditableArtifactDurableExportError("not_found");
      return result.version;
    }
    throw new EditableArtifactDurableExportError("conflict");
  }

  private async requireExportPermission(context: DurableExportContext): Promise<number> {
    const decision = await this.dependencies.authorization.authorize({
      ...context,
      permission: "export",
    });
    if (!decision.allowed) throw new EditableArtifactDurableExportError("forbidden");
    if (!Number.isSafeInteger(decision.revision) || decision.revision < 1) {
      throw new EditableArtifactDurableExportError("unavailable");
    }
    return decision.revision;
  }
}

export function editableArtifactMaterializationMimeType(
  format: EditableArtifactMaterializationFormat,
): EditableArtifactMaterializationMimeType {
  switch (format) {
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
  }
}

export function editableArtifactFormatMatchesModality(
  modality: EditableArtifactModality,
  format: EditableArtifactMaterializationFormat,
): boolean {
  return (
    (modality === "spreadsheet" && ["xlsx", "pdf", "png", "webp"].includes(format)) ||
    (modality === "presentation" && ["pptx", "pdf", "png", "webp"].includes(format)) ||
    (modality === "document" && ["docx", "pdf", "png", "webp"].includes(format))
  );
}

function normalizeContext(input: DurableExportContext): DurableExportContext {
  const scope = editableArtifactScope(input.scope);
  const artifactId = editableArtifactId(input.artifactId);
  validateEditableArtifactActor(input.actor);
  return Object.freeze({
    scope,
    artifactId,
    actor: Object.freeze({ ...input.actor }) as EditableArtifactActor,
  });
}

function stableId(value: string, _label: string): string {
  if (!PORTABLE_ID.test(value) || /^0+$/u.test(value)) {
    throw new EditableArtifactDurableExportError("invalid_request");
  }
  return value;
}

function portableIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new EditableArtifactDurableExportError("invalid_request");
  }
  return value;
}

function versionName(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).byteLength < 1 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    !wellFormedText(value)
  ) {
    throw new EditableArtifactDurableExportError("invalid_request");
  }
  return value;
}

function materializationFormat(value: string): EditableArtifactMaterializationFormat {
  if (!["xlsx", "pptx", "docx", "pdf", "png", "webp"].includes(value)) {
    throw new EditableArtifactDurableExportError("invalid_request");
  }
  return value as EditableArtifactMaterializationFormat;
}

function exactOptions(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) throw new EditableArtifactDurableExportError("invalid_request");
  const canonical = canonicalJson(value);
  if (new TextEncoder().encode(canonical).byteLength > EDITABLE_ARTIFACT_EXPORT_MAX_OPTIONS_BYTES) {
    throw new EditableArtifactDurableExportError("invalid_request");
  }
  return Object.freeze({ ...value });
}

function canonicalJson(value: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(value).sort(compareCodeUnits);
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    if (!wellFormedText(key) || !jsonValue(value[key])) {
      throw new EditableArtifactDurableExportError("invalid_request");
    }
    normalized[key] = value[key];
  }
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) throw new EditableArtifactDurableExportError("invalid_request");
  return encoded;
}

function validateProfile(
  profile: EditableArtifactMaterializationProfile,
  modality: EditableArtifactModality,
  format: EditableArtifactMaterializationFormat,
): void {
  if (
    !plainRecord(profile) ||
    profile.modality !== modality ||
    profile.format !== format ||
    !editableArtifactFormatMatchesModality(modality, format) ||
    !boundedProfileText(profile.codecId, 128) ||
    !boundedProfileText(profile.codecVersion, 128) ||
    !boundedProfileText(profile.kernelVersion, 512) ||
    !SHA256.test(profile.fontRegistryHash) ||
    !SHA256.test(profile.policyHash) ||
    profile.normalizedOptions.trim() !== profile.normalizedOptions ||
    new TextEncoder().encode(profile.normalizedOptions).byteLength >
      EDITABLE_ARTIFACT_EXPORT_MAX_OPTIONS_BYTES
  ) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(profile.normalizedOptions) as unknown;
  } catch {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  if (!plainRecord(decoded) || canonicalJson(decoded) !== profile.normalizedOptions) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
}

function boundedProfileText(value: string, maximumBytes: number): boolean {
  return (
    typeof value === "string" &&
    PROFILE_TEXT.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function hashPublicRequest(kind: string, fields: readonly string[]): string {
  const digest = createHash("sha256");
  digest.update("OpenGeni editable artifact durable export\0v1\0", "utf8");
  digest.update(kind, "utf8");
  digest.update("\0", "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    digest.update(length);
    digest.update(bytes);
  }
  return `sha256:${digest.digest("hex")}`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value !== "string" || wellFormedText(value);
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 10_000 && value.every((item) => jsonValue(item, depth + 1));
  if (!plainRecord(value) || Object.keys(value).length > 10_000) return false;
  return Object.entries(value).every(
    ([key, item]) => wellFormedText(key) && jsonValue(item, depth + 1),
  );
}

function wellFormedText(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateEditableArtifactPinnedVersion(
  version: EditableArtifactPinnedVersion,
): EditableArtifactPinnedVersion {
  const scope = editableArtifactScope(version.scope);
  const artifactId = editableArtifactId(version.artifactId);
  const id = stableId(version.id, "version id");
  const snapshotId = editableArtifactSnapshotId(version.snapshotId);
  if (!Number.isSafeInteger(version.headSequence) || version.headSequence < 0) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  const stateHash = editableArtifactStateHash(version.stateHash);
  versionName(version.name);
  assertIsoTimestamp(version.createdAt, "version creation time");
  if (version.pinned !== true || !wellFormedText(version.createdBySubjectId)) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  if (
    (version.modality === "spreadsheet" &&
      (!Array.isArray(version.causalFrontier) || version.nativeRevision !== null)) ||
    (version.modality !== "spreadsheet" &&
      (version.causalFrontier !== null ||
        !Number.isSafeInteger(version.nativeRevision) ||
        version.nativeRevision! < 0))
  ) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  return Object.freeze({
    ...version,
    scope,
    artifactId,
    id,
    snapshotId,
    stateHash,
    causalFrontier:
      version.causalFrontier === null
        ? null
        : Object.freeze(version.causalFrontier.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function validateEditableArtifactMaterializationJob(
  job: EditableArtifactMaterializationJob,
): EditableArtifactMaterializationJob {
  const scope = editableArtifactScope(job.scope);
  const artifactId = editableArtifactId(job.artifactId);
  const id = stableId(job.id, "job id");
  const versionId = stableId(job.versionId, "version id");
  const inputSnapshotId = stableId(job.inputSnapshotId, "snapshot id");
  const stateHash = editableArtifactStateHash(job.stateHash);
  const format = materializationFormat(job.format);
  if (
    !Number.isSafeInteger(job.targetHeadSequence) ||
    job.targetHeadSequence < 0 ||
    !Number.isSafeInteger(job.attemptCount) ||
    job.attemptCount < 0 ||
    !["pending", "running", "succeeded", "failed"].includes(job.state)
  ) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  assertIsoTimestamp(job.createdAt, "job creation time");
  if (job.startedAt !== null) assertIsoTimestamp(job.startedAt, "job start time");
  if (job.completedAt !== null) assertIsoTimestamp(job.completedAt, "job completion time");
  let result: EditableArtifactMaterializationResult | null = null;
  if (job.result) {
    result = Object.freeze({
      ...job.result,
      id: stableId(job.result.id, "result id"),
      contentHash: editableArtifactContentHash(job.result.contentHash),
      mimeType: editableArtifactMaterializationMimeType(format),
    });
    if (
      job.result.mimeType !== result.mimeType ||
      !Number.isSafeInteger(job.result.byteSize) ||
      job.result.byteSize < 1 ||
      job.result.byteSize > EDITABLE_ARTIFACT_EXPORT_MAX_DOWNLOAD_BYTES
    ) {
      throw new EditableArtifactDurableExportError("unavailable");
    }
    assertIsoTimestamp(job.result.verifiedAt, "result verification time");
    assertIsoTimestamp(job.result.createdAt, "result creation time");
  }
  if ((job.state === "succeeded") !== (result !== null)) {
    throw new EditableArtifactDurableExportError("unavailable");
  }
  return Object.freeze({
    ...job,
    scope,
    artifactId,
    id,
    versionId,
    inputSnapshotId,
    stateHash,
    format,
    result,
  });
}
