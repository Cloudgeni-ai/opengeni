import type { AccessGrant, FileAsset } from "@opengeni/contracts";
import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";
import {
  EditableArtifactCompatibilityError,
  EditableArtifactDurableExportError,
  EditableArtifactDomainError,
  EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES,
  MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
  editableArtifactClientTransactionId,
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactScope,
  editableArtifactStateHash,
  hasPermission,
  requireAccessGrant,
  type AccessDeps,
  type EditableArtifact,
  type EditableArtifactActor,
  type EditableArtifactApplicationPort,
  type EditableArtifactDurableExportService,
  type EditableArtifactMaterializationDownload,
  type EditableArtifactMaterializationJob,
  type EditableArtifactPinnedVersion,
  type EditableArtifactModality,
  type ImportEditableArtifactApplicationInput,
} from "@opengeni/core";
import { getFile } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";

import { ApiHttpError } from "../http/api-error";

export const EDITABLE_ARTIFACT_HTTP_REQUEST_MAX_BYTES = 4 * 1024;
export const EDITABLE_ARTIFACT_EXPORT_REQUEST_MAX_BYTES = 260 * 1024;
export const EDITABLE_ARTIFACT_IMPORT_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const EDITABLE_ARTIFACT_LIVE_TICKET_REQUEST_MAX_BYTES =
  EDITABLE_ARTIFACT_HTTP_REQUEST_MAX_BYTES;

const portableId = /^[0-9a-f]+$/;
const liveTicketToken = /^[A-Za-z0-9._~-]+$/;

const ArtifactId = z
  .string()
  .length(32)
  .regex(portableId)
  .refine((value) => !/^0+$/.test(value));
const ReplicaId = z
  .string()
  .length(16)
  .regex(portableId)
  .refine((value) => !/^0+$/.test(value));
const BoundedIdentity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const PositiveProtocolVersion = z.number().int().positive().max(2_147_483_647);
const PositiveModelSchemaVersion = z.number().int().positive().max(65_535);
const VersionName = z
  .string()
  .min(1)
  .refine(
    (value) =>
      utf8ByteLength(value) <= EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES &&
      value.trim() === value &&
      isWellFormedPersistedText(value),
  );
const AttemptId = z.string().uuid();
const AttemptGeneration = z.number().int().positive().max(2_147_483_647);

const MintEditableArtifactLiveTicketRequest = z
  .object({
    replicaId: ReplicaId,
    protocolVersion: PositiveProtocolVersion,
    kernelVersion: VersionName,
    modelSchemaVersion: PositiveModelSchemaVersion,
  })
  .strict();

const CreateEditableArtifactRequest = z
  .object({
    replicaId: ReplicaId,
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    title: z.string().refine(isValidArtifactTitle),
  })
  .strict();

const ImportSnapshotCommon = {
  blobReference: z.string().min(1).max(1_024),
  byteSize: z.number().int().positive().max(MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  mimeType: z.literal("application/vnd.opengeni.editable-artifact-snapshot"),
  coveredHeadSequence: z.literal(0),
  stateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  modelSchemaVersion: PositiveModelSchemaVersion,
  kernelVersion: VersionName,
} as const;

const ImportEditableArtifactSnapshot = z.discriminatedUnion("modality", [
  z
    .object({
      ...ImportSnapshotCommon,
      modality: z.literal("spreadsheet"),
      coveredCausalFrontier: z
        .array(
          z
            .object({
              replicaId: ReplicaId,
              counter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        )
        .max(65_536),
      operationProtocolVersion: PositiveProtocolVersion,
      crdtStateVersion: PositiveProtocolVersion,
    })
    .strict(),
  z
    .object({
      ...ImportSnapshotCommon,
      modality: z.literal("document"),
      nativeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      ...ImportSnapshotCommon,
      modality: z.literal("presentation"),
      nativeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);

const ImportEditableArtifactRequest = z
  .object({
    replicaId: ReplicaId,
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    title: z.string().refine(isValidArtifactTitle),
    sourceFileId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    snapshot: ImportEditableArtifactSnapshot,
  })
  .strict()
  .refine((value) => value.modality === value.snapshot.modality);

const PinEditableArtifactVersionRequest = z
  .object({
    replicaId: ReplicaId,
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    name: z
      .string()
      .refine(
        (value) =>
          value.trim() === value &&
          !/[\u0000-\u001f\u007f]/u.test(value) &&
          utf8ByteLength(value) >= 1 &&
          utf8ByteLength(value) <= 256 &&
          isWellFormedPersistedText(value),
      ),
  })
  .strict();

const EnqueueEditableArtifactMaterializationRequest = z
  .object({
    replicaId: ReplicaId,
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    versionId: ArtifactId,
    format: z.enum(["xlsx", "pptx", "docx", "pdf", "png", "webp"]),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const MintEditableArtifactLiveTicketResult = z
  .object({
    artifactId: ArtifactId,
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    replicaId: ReplicaId,
    token: z.string().min(1).max(4_096).regex(liveTicketToken),
    expiresAt: z.string().datetime({ offset: true }),
    protocolVersion: PositiveProtocolVersion,
  })
  .strict();

const EditableArtifactResult = z
  .object({
    id: ArtifactId,
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    title: z.string().min(1).max(512),
    lifecycle: z.enum(["active", "archived"]),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const PinnedVersionResult = z
  .object({
    id: ArtifactId,
    artifactId: ArtifactId,
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    snapshotId: ArtifactId,
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    causalFrontier: z
      .array(
        z
          .object({
            replicaId: ReplicaId,
            counter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .nullable(),
    nativeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    stateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    name: z.string().min(1),
    pinned: z.literal(true),
    createdAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict();

const MaterializationResult = z
  .object({
    id: ArtifactId,
    byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    mimeType: z.enum([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/pdf",
      "image/png",
      "image/webp",
    ]),
    verifiedAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

const MaterializationJobResult = z
  .object({
    id: ArtifactId,
    artifactId: ArtifactId,
    versionId: ArtifactId,
    inputSnapshotId: ArtifactId,
    targetHeadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    format: z.enum(["xlsx", "pptx", "docx", "pdf", "png", "webp"]),
    state: z.enum(["pending", "running", "succeeded", "failed"]),
    attemptCount: z.number().int().nonnegative().max(1_000),
    errorCode: z.string().min(1).max(256).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    result: MaterializationResult.nullable(),
    replayed: z.boolean().optional(),
  })
  .strict();

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isWellFormedPersistedText(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isValidArtifactTitle(value: string): boolean {
  const bytes = utf8ByteLength(value);
  return bytes >= 1 && bytes <= 512 && value.trim() === value && isWellFormedPersistedText(value);
}

export type EditableArtifactRouteScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

export type EditableArtifactRouteActor = EditableArtifactActor;

/**
 * Authenticated transport context. Until a distinct editable-artifact
 * capability is introduced, the existing workspace `artifacts:read` and
 * `artifacts:publish` capabilities intentionally gate read and write here too;
 * the application still performs the durable per-artifact authorization.
 */
export type EditableArtifactRouteAuthority = Readonly<{
  scope: EditableArtifactRouteScope;
  actor: EditableArtifactRouteActor;
}>;

export type MintEditableArtifactLiveTicketOutput = Readonly<{
  artifactId: string;
  modality: EditableArtifactModality;
  replicaId: string;
  token: string;
  expiresAt: string;
  protocolVersion: number;
}>;

export type EditableArtifactRouteDependencies = AccessDeps &
  Readonly<{
    editableArtifacts?: EditableArtifactApplicationPort;
    editableArtifactExports?: EditableArtifactDurableExportService;
    /** Test/embedding seam; standalone defaults to the RLS-scoped DB lookup. */
    editableArtifactImportSource?: (
      workspaceId: string,
      fileId: string,
    ) => Promise<FileAsset | null>;
  }>;

export type EditableArtifactApplicationErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "unsupported_protocol"
  | "limit_exceeded"
  | "unavailable";

/** A bounded, deliberate failure emitted by the injected application boundary. */
export class EditableArtifactApplicationError extends Error {
  constructor(readonly code: EditableArtifactApplicationErrorCode) {
    super(code);
    this.name = "EditableArtifactApplicationError";
  }
}

export function registerEditableArtifactRoutes(
  app: Hono,
  deps: EditableArtifactRouteDependencies,
): void {
  const collection = "/v1/workspaces/:workspaceId/editable-artifacts";
  const item = `${collection}/:artifactId`;

  app.post(collection, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const body = await parseBoundedCreateRequest(context);
    const application = requireEditableArtifactApplication(deps);
    const scope = editableArtifactScope({
      accountId: grant.accountId,
      workspaceId,
    });
    const actor = editableArtifactActorForGrant(grant, body.replicaId);
    let artifact: EditableArtifact;
    try {
      artifact = await application.createArtifact({
        scope,
        actor,
        idempotencyKey: editableArtifactClientTransactionId(body.idempotencyKey),
        modality: body.modality as EditableArtifactModality,
        title: body.title,
        signal: context.req.raw.signal,
      });
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
    const result = projectArtifact(artifact, scope);
    context.header("cache-control", "private, no-store");
    return context.json(result, 201);
  });

  app.post(`${collection}/imports`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    if (!hasPermission(grant.permissions, "files:read")) {
      throw applicationHttpError("forbidden");
    }
    const body = await parseBoundedImportRequest(context);
    const source = await (deps.editableArtifactImportSource
      ? deps.editableArtifactImportSource(workspaceId, body.sourceFileId)
      : getFile(deps.db, workspaceId, body.sourceFileId));
    const expectedSourceMime = officeMimeType(body.modality);
    if (
      !source ||
      source.workspaceId !== workspaceId ||
      source.status !== "ready" ||
      source.contentType !== expectedSourceMime ||
      source.sizeBytes < 1 ||
      source.sizeBytes > EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES ||
      typeof source.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(source.sha256)
    ) {
      throw new ApiHttpError(422, {
        code: "validation_failed",
        message: "Editable artifact import source is not a ready Office file.",
      });
    }
    const expectedSnapshotReference = `editable-artifacts/snapshots/sha256/${body.snapshot.contentHash.slice("sha256:".length)}`;
    if (body.snapshot.blobReference !== expectedSnapshotReference) {
      throw new ApiHttpError(422, {
        code: "validation_failed",
        message: "Editable artifact snapshot reference is invalid.",
      });
    }
    const scope = editableArtifactScope({ accountId: grant.accountId, workspaceId });
    const actor = editableArtifactActorForGrant(grant, body.replicaId);
    try {
      const artifact = await requireEditableArtifactApplication(deps).importArtifact({
        scope,
        actor,
        idempotencyKey: editableArtifactClientTransactionId(body.idempotencyKey),
        modality: body.modality,
        title: body.title,
        originalImport: {
          fileId: source.id,
          blobReference: source.objectKey,
          byteSize: source.sizeBytes,
          contentHash: editableArtifactContentHash(`sha256:${source.sha256}`),
          mimeType: expectedSourceMime,
        },
        snapshot: normalizeImportSnapshot(body.snapshot),
        signal: context.req.raw.signal,
      });
      context.header("cache-control", "private, no-store");
      return context.json(projectArtifact(artifact, scope), 201);
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
  });

  app.get(item, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const artifactId = editableArtifactId(parseArtifactId(context.req.param("artifactId")));
    const actor = editableArtifactActorForGrant(grant, context.req.query("replicaId") ?? "");
    const scope = editableArtifactScope({
      accountId: grant.accountId,
      workspaceId,
    });
    let artifact: EditableArtifact;
    try {
      artifact = await requireEditableArtifactApplication(deps).readArtifact({
        scope,
        actor,
        artifactId,
      });
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
    context.header("cache-control", "private, no-store");
    return context.json(projectArtifact(artifact, scope), 200);
  });

  app.post(`${item}/live-ticket`, async (context) => {
    const workspaceId = context.req.param("workspaceId");

    // Workspace authentication precedes path/body parsing. Exact artifact
    // permission is intentionally enforced inside the injected application.
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const artifactId = editableArtifactId(parseArtifactId(context.req.param("artifactId")));
    const body = await parseBoundedTicketRequest(context);
    const actor = editableArtifactActorForGrant(grant, body.replicaId);
    const scope = editableArtifactScope({
      accountId: grant.accountId,
      workspaceId,
    });

    let rawTicket: MintEditableArtifactLiveTicketOutput;
    try {
      rawTicket = await requireEditableArtifactApplication(deps).mintLiveTicket({
        scope,
        actor,
        artifactId,
        protocolVersion: body.protocolVersion,
        kernelVersion: body.kernelVersion,
        modelSchemaVersion: body.modelSchemaVersion,
        allowEdit: hasPermission(grant.permissions, "artifacts:publish"),
      });
    } catch (error) {
      throw editableArtifactHttpError(error);
    }

    const parsedTicket = MintEditableArtifactLiveTicketResult.safeParse(rawTicket);
    if (
      !parsedTicket.success ||
      parsedTicket.data.artifactId !== artifactId ||
      parsedTicket.data.replicaId !== actor.replicaId ||
      parsedTicket.data.protocolVersion !== body.protocolVersion ||
      Date.parse(parsedTicket.data.expiresAt) <= Date.now()
    ) {
      throw new Error("Editable artifact application returned an invalid live ticket");
    }

    context.header("cache-control", "private, no-store");
    return context.json(parsedTicket.data, 201);
  });

  app.post(`${item}/versions`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const artifactId = editableArtifactId(parseArtifactId(context.req.param("artifactId")));
    const body = await parseBoundedVersionRequest(context);
    const scope = editableArtifactScope({ accountId: grant.accountId, workspaceId });
    const actor = editableArtifactActorForGrant(grant, body.replicaId);
    try {
      const result = await requireEditableArtifactExports(deps).pinVersion({
        scope,
        actor,
        artifactId,
        idempotencyKey: body.idempotencyKey,
        name: body.name,
        signal: context.req.raw.signal,
      });
      context.header("cache-control", "private, no-store");
      return context.json(
        projectPinnedVersion(result.version, scope, artifactId, result.replayed),
        201,
      );
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
  });

  app.post(`${item}/materializations`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const artifactId = editableArtifactId(parseArtifactId(context.req.param("artifactId")));
    const body = await parseBoundedMaterializationRequest(context);
    const scope = editableArtifactScope({ accountId: grant.accountId, workspaceId });
    const actor = editableArtifactActorForGrant(grant, body.replicaId);
    try {
      const result = await requireEditableArtifactExports(deps).enqueueMaterialization({
        scope,
        actor,
        artifactId,
        idempotencyKey: body.idempotencyKey,
        versionId: body.versionId,
        format: body.format,
        ...(body.options ? { options: body.options } : {}),
      });
      context.header("cache-control", "private, no-store");
      return context.json(
        projectMaterializationJob(result.job, scope, artifactId, result.replayed),
        201,
      );
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
  });

  app.get(`${item}/materializations/:jobId`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const artifactId = editableArtifactId(parseArtifactId(context.req.param("artifactId")));
    const jobId = parseArtifactId(context.req.param("jobId"));
    const actor = editableArtifactActorForGrant(grant, context.req.query("replicaId") ?? "");
    const scope = editableArtifactScope({ accountId: grant.accountId, workspaceId });
    try {
      const job = await requireEditableArtifactExports(deps).getMaterialization({
        scope,
        actor,
        artifactId,
        jobId,
      });
      context.header("cache-control", "private, no-store");
      return context.json(projectMaterializationJob(job, scope, artifactId), 200);
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
  });

  app.get(`${item}/materializations/:jobId/download`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const artifactId = editableArtifactId(parseArtifactId(context.req.param("artifactId")));
    const jobId = parseArtifactId(context.req.param("jobId"));
    const actor = editableArtifactActorForGrant(grant, context.req.query("replicaId") ?? "");
    const scope = editableArtifactScope({ accountId: grant.accountId, workspaceId });
    let download: EditableArtifactMaterializationDownload;
    try {
      download = await requireEditableArtifactExports(deps).openMaterializationDownload({
        scope,
        actor,
        artifactId,
        jobId,
        signal: context.req.raw.signal,
      });
    } catch (error) {
      throw editableArtifactHttpError(error);
    }
    const stream = materializationDownloadStream(download, context.req.raw.signal);
    return new Response(stream, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="artifact-${artifactId}.${download.format}"`,
        "content-length": String(download.byteSize),
        "content-type": download.mimeType,
        etag: `"${download.contentHash}"`,
        "x-content-type-options": "nosniff",
      },
    });
  });
}

function requireEditableArtifactApplication(
  deps: EditableArtifactRouteDependencies,
): EditableArtifactApplicationPort {
  if (!deps.editableArtifacts) {
    throw editableArtifactHttpError(new EditableArtifactApplicationError("unavailable"));
  }
  return deps.editableArtifacts;
}

function requireEditableArtifactExports(
  deps: EditableArtifactRouteDependencies,
): EditableArtifactDurableExportService {
  if (!deps.editableArtifactExports) {
    throw editableArtifactHttpError(new EditableArtifactApplicationError("unavailable"));
  }
  return deps.editableArtifactExports;
}

function projectArtifact(
  artifact: EditableArtifact,
  expectedScope: EditableArtifactRouteScope,
): z.infer<typeof EditableArtifactResult> {
  if (
    artifact.scope.accountId !== expectedScope.accountId ||
    artifact.scope.workspaceId !== expectedScope.workspaceId
  ) {
    throw new Error("Editable artifact application returned cross-tenant metadata");
  }
  const parsed = EditableArtifactResult.safeParse({
    id: artifact.id,
    modality: artifact.modality,
    title: artifact.title,
    lifecycle: artifact.lifecycle,
    headSequence: artifact.headSequence,
    stateHash: artifact.stateHash,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  });
  if (!parsed.success) throw new Error("Editable artifact application returned invalid metadata");
  return parsed.data;
}

function projectPinnedVersion(
  version: EditableArtifactPinnedVersion,
  expectedScope: EditableArtifactRouteScope,
  expectedArtifactId: string,
  replayed: boolean,
): z.infer<typeof PinnedVersionResult> {
  if (
    version.scope.accountId !== expectedScope.accountId ||
    version.scope.workspaceId !== expectedScope.workspaceId ||
    version.artifactId !== expectedArtifactId
  ) {
    throw new Error("Editable artifact export returned cross-tenant version metadata");
  }
  const parsed = PinnedVersionResult.safeParse({
    id: version.id,
    artifactId: version.artifactId,
    modality: version.modality,
    snapshotId: version.snapshotId,
    headSequence: version.headSequence,
    causalFrontier: version.causalFrontier,
    nativeRevision: version.nativeRevision,
    stateHash: version.stateHash,
    name: version.name,
    pinned: version.pinned,
    createdAt: version.createdAt,
    replayed,
  });
  if (!parsed.success)
    throw new Error("Editable artifact export returned invalid version metadata");
  return parsed.data;
}

function projectMaterializationJob(
  job: EditableArtifactMaterializationJob,
  expectedScope: EditableArtifactRouteScope,
  expectedArtifactId: string,
  replayed?: boolean,
): z.infer<typeof MaterializationJobResult> {
  if (
    job.scope.accountId !== expectedScope.accountId ||
    job.scope.workspaceId !== expectedScope.workspaceId ||
    job.artifactId !== expectedArtifactId
  ) {
    throw new Error("Editable artifact export returned cross-tenant job metadata");
  }
  const parsed = MaterializationJobResult.safeParse({
    id: job.id,
    artifactId: job.artifactId,
    versionId: job.versionId,
    inputSnapshotId: job.inputSnapshotId,
    targetHeadSequence: job.targetHeadSequence,
    stateHash: job.stateHash,
    format: job.format,
    state: job.state,
    attemptCount: job.attemptCount,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result,
    ...(replayed === undefined ? {} : { replayed }),
  });
  if (!parsed.success) throw new Error("Editable artifact export returned invalid job metadata");
  return parsed.data;
}

function materializationDownloadStream(
  download: EditableArtifactMaterializationDownload,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = download.chunks({ signal })[Symbol.asyncIterator]();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await download.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        await download.assertUnchanged(signal);
        await close();
        controller.close();
      } catch {
        await close();
        controller.error(new Error("Editable artifact materialization download failed"));
      }
    },
    async cancel() {
      try {
        await iterator.return?.();
      } finally {
        await close();
      }
    },
  });
}

export function editableArtifactActorForGrant(
  grant: AccessGrant,
  rawReplicaId: string,
): EditableArtifactRouteActor {
  const replicaId = editableArtifactReplicaId(parseReplicaId(rawReplicaId));
  const subject = BoundedIdentity.safeParse(grant.subjectId);
  if (!subject.success) throw invalidMachineAuthority("Invalid artifact actor subject");

  const attemptValues = {
    sessionId: grant.metadata?.["sessionId"],
    turnId: grant.metadata?.["turnId"],
    attemptId: grant.metadata?.["attemptId"],
    generation: grant.metadata?.["executionGeneration"],
  };
  const hasAnyAttemptClaim = Object.values(attemptValues).some((value) => value !== undefined);

  if (grant.principalKind === "human_session") {
    if (hasAnyAttemptClaim || grant.serviceInitiator || grant.serviceInitiatorContext) {
      throw invalidMachineAuthority("Human artifact authority contains machine claims");
    }
    return Object.freeze({ kind: "human", subjectId: subject.data, replicaId });
  }

  if (grant.principalKind === "agent_attempt") {
    if (grant.serviceInitiator || grant.serviceInitiatorContext) {
      throw invalidMachineAuthority("Agent artifact authority contains service claims");
    }
    const parsedAttempt = z
      .object({
        sessionId: AttemptId,
        turnId: AttemptId,
        attemptId: AttemptId,
        generation: AttemptGeneration,
      })
      .strict()
      .safeParse(attemptValues);
    if (!parsedAttempt.success) {
      throw invalidMachineAuthority("Agent artifact authority is incomplete");
    }
    return Object.freeze({
      kind: "agent",
      subjectId: subject.data,
      replicaId,
      ...parsedAttempt.data,
    });
  }

  if (grant.principalKind === "service") {
    if (hasAnyAttemptClaim || (grant.serviceInitiatorContext && !grant.serviceInitiator)) {
      throw invalidMachineAuthority("Service artifact authority contains invalid claims");
    }
    // Keep delegated service provenance distinct from database-backed API keys
    // and configured subjects with durable workspace memberships.
    return Object.freeze({
      kind: "service",
      subjectId: subject.data,
      replicaId,
      service: "delegated_service",
    });
  }

  if (grant.principalKind === "api_key" || grant.principalKind === "configured_key") {
    if (hasAnyAttemptClaim || grant.serviceInitiator || grant.serviceInitiatorContext) {
      throw invalidMachineAuthority("Key artifact authority contains machine claims");
    }
    return Object.freeze({
      kind: "service",
      subjectId: subject.data,
      replicaId,
      service: grant.principalKind,
    });
  }

  throw invalidMachineAuthority("Artifact authority has no trusted principal kind");
}

function parseArtifactId(value: string): string {
  const parsed = ArtifactId.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact id.",
    });
  }
  return parsed.data;
}

function parseReplicaId(value: string): string {
  const parsed = ReplicaId.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact replica id.",
    });
  }
  return parsed.data;
}

async function parseBoundedTicketRequest(
  context: Context,
): Promise<z.infer<typeof MintEditableArtifactLiveTicketRequest>> {
  const value = await readBoundedJson(
    context.req.raw,
    EDITABLE_ARTIFACT_LIVE_TICKET_REQUEST_MAX_BYTES,
  );
  const parsed = MintEditableArtifactLiveTicketRequest.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact live-ticket request.",
    });
  }
  return parsed.data;
}

async function parseBoundedCreateRequest(
  context: Context,
): Promise<z.infer<typeof CreateEditableArtifactRequest>> {
  const value = await readBoundedJson(context.req.raw, EDITABLE_ARTIFACT_HTTP_REQUEST_MAX_BYTES);
  const parsed = CreateEditableArtifactRequest.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact create request.",
    });
  }
  return parsed.data;
}

async function parseBoundedImportRequest(
  context: Context,
): Promise<z.infer<typeof ImportEditableArtifactRequest>> {
  const value = await readBoundedJson(context.req.raw, EDITABLE_ARTIFACT_IMPORT_REQUEST_MAX_BYTES);
  const parsed = ImportEditableArtifactRequest.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact import request.",
    });
  }
  return parsed.data;
}

function officeMimeType(
  modality: EditableArtifactModality,
):
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation" {
  return modality === "spreadsheet"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : modality === "document"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function normalizeImportSnapshot(
  snapshot: z.infer<typeof ImportEditableArtifactSnapshot>,
): ImportEditableArtifactApplicationInput["snapshot"] {
  const common = {
    blobReference: snapshot.blobReference,
    byteSize: snapshot.byteSize,
    contentHash: editableArtifactContentHash(snapshot.contentHash),
    mimeType: snapshot.mimeType,
    coveredHeadSequence: snapshot.coveredHeadSequence,
    stateHash: editableArtifactStateHash(snapshot.stateHash),
    modelSchemaVersion: snapshot.modelSchemaVersion,
    kernelVersion: snapshot.kernelVersion,
  } as const;
  return snapshot.modality === "spreadsheet"
    ? Object.freeze({
        ...common,
        modality: "spreadsheet" as const,
        coveredCausalFrontier: editableArtifactCausalFrontier(
          snapshot.coveredCausalFrontier.map((entry) => ({
            replicaId: editableArtifactReplicaId(entry.replicaId),
            counter: entry.counter,
          })),
        ),
        operationProtocolVersion: snapshot.operationProtocolVersion,
        crdtStateVersion: snapshot.crdtStateVersion,
      })
    : Object.freeze({
        ...common,
        modality: snapshot.modality,
        nativeRevision: snapshot.nativeRevision,
      });
}

async function parseBoundedVersionRequest(
  context: Context,
): Promise<z.infer<typeof PinEditableArtifactVersionRequest>> {
  const value = await readBoundedJson(context.req.raw, EDITABLE_ARTIFACT_HTTP_REQUEST_MAX_BYTES);
  const parsed = PinEditableArtifactVersionRequest.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact version request.",
    });
  }
  return parsed.data;
}

async function parseBoundedMaterializationRequest(
  context: Context,
): Promise<z.infer<typeof EnqueueEditableArtifactMaterializationRequest>> {
  const value = await readBoundedJson(context.req.raw, EDITABLE_ARTIFACT_EXPORT_REQUEST_MAX_BYTES);
  const parsed = EnqueueEditableArtifactMaterializationRequest.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "Invalid editable artifact materialization request.",
    });
  }
  return parsed.data;
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw invalidTicketBody();
    }
    if (parsedLength > maxBytes) throw ticketBodyTooLarge();
  }

  if (!request.body) throw invalidTicketBody();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Bun's server-request reader currently throws from releaseLock(). The
  // bounded reader is discarded after complete consumption or cancellation,
  // so application code does not retain the lock.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw ticketBodyTooLarge();
    }
    chunks.push(value);
  }
  if (total === 0) throw invalidTicketBody();

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidTicketBody();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidTicketBody();
  }
}

function editableArtifactHttpError(error: unknown): unknown {
  if (error instanceof EditableArtifactDurableExportError) {
    switch (error.code) {
      case "invalid_request":
        return new ApiHttpError(422, {
          code: "validation_failed",
          message: "Invalid editable artifact export request.",
        });
      case "not_found":
        return applicationHttpError("not_found");
      case "forbidden":
        return applicationHttpError("forbidden");
      case "conflict":
        return applicationHttpError("conflict");
      case "unsupported_format":
        return new ApiHttpError(422, {
          code: "validation_failed",
          message: "Editable artifact format is not available for this artifact.",
        });
      case "not_ready":
        return new ApiHttpError(409, {
          code: "conflict",
          message: "Editable artifact materialization is not ready.",
          retryable: true,
        });
      case "unavailable":
        return applicationHttpError("unavailable");
    }
  }
  if (error instanceof EditableArtifactCompatibilityError) {
    return applicationHttpError(error.code);
  }
  if (error instanceof EditableArtifactDomainError) {
    switch (error.code) {
      case "not_found":
        return applicationHttpError("not_found");
      case "forbidden":
        return applicationHttpError("forbidden");
      case "idempotency_conflict":
      case "causal_future":
      case "causal_chain_conflict":
      case "retryable_conflict":
      case "snapshot_conflict":
      case "not_editable":
        return applicationHttpError("conflict");
      case "invalid_request":
      case "request_hash_mismatch":
      case "invalid_undo_target":
        return new ApiHttpError(422, {
          code: "validation_failed",
          message: "Invalid editable artifact request.",
        });
      case "kernel_contract_violation":
      case "outbox_lease_conflict":
        return applicationHttpError("unavailable");
    }
  }
  if (!(error instanceof EditableArtifactApplicationError)) return error;
  return applicationHttpError(error.code);
}

function applicationHttpError(code: EditableArtifactApplicationErrorCode): ApiHttpError {
  switch (code) {
    case "not_found":
      return new ApiHttpError(404, {
        code: "not_found",
        message: "Editable artifact not found.",
      });
    case "forbidden":
      return new ApiHttpError(403, {
        code: "forbidden",
        message: "Editable artifact access denied.",
      });
    case "conflict":
      return new ApiHttpError(409, {
        code: "conflict",
        message: "Editable artifact state changed. Retry from current state.",
      });
    case "unsupported_protocol":
      return new ApiHttpError(409, {
        code: "conflict",
        message: "Editable artifact protocol is not supported.",
      });
    case "limit_exceeded":
      return new ApiHttpError(429, {
        code: "limit_exceeded",
        message: "Editable artifact live-session limit exceeded.",
        retryable: true,
      });
    case "unavailable":
      return new ApiHttpError(503, {
        code: "upstream_unavailable",
        message: "Editable artifact live service is temporarily unavailable.",
        retryable: true,
      });
  }
}

function invalidMachineAuthority(message: string): ApiHttpError {
  return new ApiHttpError(403, { code: "forbidden", message });
}

function invalidTicketBody(): ApiHttpError {
  return new ApiHttpError(422, {
    code: "validation_failed",
    message: "Invalid editable artifact live-ticket request.",
  });
}

function ticketBodyTooLarge(): ApiHttpError {
  return new ApiHttpError(413, {
    code: "validation_failed",
    message: "Editable artifact live-ticket request is too large.",
  });
}
