import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import { hasLiteralPermission, hasPermission, siteViewerForGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import type { AccessGrant, SiteDataDescribeResponse } from "@opengeni/contracts";
import {
  createPostgresSiteDataStore,
  getSiteDataSite,
  recordUsageEvent,
  SiteDataError,
  type Database,
  type SiteDataCaller,
  type SiteDataLimits,
  type SiteDataSite,
  type SiteDataStore,
  type SiteDataWriteOptions,
  type SiteDataWriteSummary,
} from "@opengeni/db";

/**
 * Site Data service: resolves who is calling (manager or viewer, and their
 * principal), applies Site state rules, and wires validation and usage
 * metering into the backend-neutral store. Every surface (HTTP, the Site
 * bridge, first-party agent tools) goes through here.
 */

export type SiteDataDeps = Pick<ApiRouteDeps, "db" | "settings">;

export type SiteDataAccess = {
  site: SiteDataSite;
  caller: SiteDataCaller;
  subjectId: string | null;
  store: SiteDataStore;
  limits: SiteDataLimits;
  writeOptions: SiteDataWriteOptions;
};

const stores = new WeakMap<object, SiteDataStore>();

/** One store per database handle. */
export function siteDataStore(db: Database): SiteDataStore {
  let store = stores.get(db);
  if (!store) {
    store = createPostgresSiteDataStore(db);
    stores.set(db, store);
  }
  return store;
}

export function siteDataLimits(settings: ApiRouteDeps["settings"]): SiteDataLimits {
  return {
    recordBytesPerSite: settings.siteDataRecordBytesPerSite,
    maxRecordBytes: settings.siteDataMaxRecordBytes,
    maxCollectionsPerSite: settings.siteDataMaxCollectionsPerSite,
    fileBytesPerSite: settings.siteDataFileBytesPerSite,
    maxFileBytes: settings.siteDataMaxFileBytes,
    workspaceBytes: settings.siteDataWorkspaceBytes,
    viewerWritesPerMinute: settings.siteDataViewerWritesPerMinute,
    siteWritesPerMinute: settings.siteDataSiteWritesPerMinute,
  };
}

export function publicSiteDataLimits(limits: SiteDataLimits): SiteDataDescribeResponse["limits"] {
  return {
    recordBytesPerSite: limits.recordBytesPerSite,
    maxRecordBytes: limits.maxRecordBytes,
    maxCollectionsPerSite: limits.maxCollectionsPerSite,
    fileBytesPerSite: limits.fileBytesPerSite,
    maxFileBytes: limits.maxFileBytes,
    workspaceBytes: limits.workspaceBytes,
  };
}

// JSON Schema validation with the tool gateway's Ajv posture: no coercion,
// defaults or format assertions. Compiled schemas are cached.
const ajv = new Ajv({
  allErrors: false,
  coerceTypes: false,
  strict: false,
  useDefaults: false,
  validateFormats: false,
});
const compiled = new Map<string, ValidateFunction | Error>();

export function validateSiteDataRecord(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): string | null {
  const cacheKey = JSON.stringify(schema);
  let validator = compiled.get(cacheKey);
  if (!validator) {
    try {
      validator = ajv.compile(schema);
    } catch (error) {
      validator = error instanceof Error ? error : new Error("Invalid JSON Schema");
    }
    if (compiled.size >= 256) compiled.delete(compiled.keys().next().value!);
    compiled.set(cacheKey, validator);
  }
  if (validator instanceof Error) return "the collection's JSON Schema is invalid";
  if (validator(data)) return null;
  const issue = validator.errors?.[0];
  return issue
    ? `${issue.instancePath || "record"} ${issue.message ?? "is invalid"}`
    : "record is invalid";
}

/** Check a collection's JSON Schema compiles before it is stored. */
export function assertSiteDataSchema(schema: Record<string, unknown> | null | undefined): void {
  if (!schema) return;
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new SiteDataError(
      "validation",
      `jsonSchema is not a valid JSON Schema: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
}

/** The record owner: the person, or the person an agent or schedule acts for. */
export function siteDataPrincipal(grant: AccessGrant, subjectId: string | null): string {
  return subjectId ? `user:${subjectId}` : `service:${grant.subjectId}`;
}

/** The writer recorded on records: agents are distinct from the person they act for. */
export function siteDataActor(grant: AccessGrant, subjectId: string | null): string {
  if (grant.principalKind === "agent_attempt") return `agent:${grant.subjectId}`;
  return siteDataPrincipal(grant, subjectId);
}

/**
 * Managers may manage the Site's data: its owner, a workspace admin, a key or
 * service without a person, or an agent acting for one of them, each with
 * `artifacts:publish`. A Site without an owner is managed by its creator.
 */
export function siteDataRole(
  grant: AccessGrant,
  site: Pick<SiteDataSite, "ownerSubjectId" | "createdBySubjectId">,
  subjectId: string | null,
): "manager" | "viewer" {
  if (!hasPermission(grant.permissions, "artifacts:publish", grant.permissionMode)) return "viewer";
  if (hasLiteralPermission(grant.permissions, "workspace:admin")) return "manager";
  if (subjectId === null) return "manager";
  const owner = site.ownerSubjectId ?? site.createdBySubjectId ?? null;
  return owner !== null && owner === subjectId ? "manager" : "viewer";
}

export type SiteDataSurface = {
  /** The pinned Site id a host attached to a Site-originated request. */
  frameSiteId?: string | null;
  /** Management surfaces: describe, define, delete, reset, import, export. */
  management?: boolean;
};

/**
 * Resolve the Site and caller. not_found when the caller cannot see the Site
 * (by audience); forbidden for an archived Site (viewers and Site frames) and
 * for management by anyone but a manager outside the Site frame.
 */
export async function resolveSiteDataAccess(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  surface: SiteDataSurface = {},
): Promise<SiteDataAccess> {
  const framed = surface.frameSiteId !== undefined && surface.frameSiteId !== null;
  if (framed && surface.frameSiteId !== siteId)
    throw new SiteDataError("forbidden", "A Site can only use its own data");
  const viewer = await siteViewerForGrant(deps.db, grant);
  const site = await getSiteDataSite(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    viewer,
    siteId,
  );
  if (!site) throw new SiteDataError("not_found", "Site not found");
  const role = siteDataRole(grant, site, viewer.subjectId);
  if (site.status !== "active" && (framed || role !== "manager"))
    throw new SiteDataError("forbidden", "This Site is archived");
  if (surface.management && (framed || role !== "manager"))
    throw new SiteDataError("forbidden", "Only the Site's managers can manage its data");
  const caller: SiteDataCaller = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    siteId,
    role,
    principal: siteDataPrincipal(grant, viewer.subjectId),
    actor: siteDataActor(grant, viewer.subjectId),
    framed,
  };
  const limits = siteDataLimits(deps.settings);
  return {
    site,
    caller,
    subjectId: viewer.subjectId,
    store: siteDataStore(deps.db),
    limits,
    writeOptions: {
      limits,
      // Managers' own tools and API calls are bounded by quotas, not windows.
      rateLimit: framed || role !== "manager",
      validate: validateSiteDataRecord,
      afterWrite: (tx, summary) =>
        meterSiteData(tx, grant, caller, viewer.subjectId, "write", summary),
    },
  };
}

/**
 * Usage metering in `usage_only` mode (docs/credit-boundaries-rollout.md): the
 * workspace pays for viewer-triggered usage; events are recorded in the write
 * transaction and never debit credits until a reviewed rate is enabled.
 */
export async function meterSiteData(
  tx: Database,
  grant: AccessGrant,
  caller: SiteDataCaller,
  subjectId: string | null,
  kind: "write" | "upload",
  summary: SiteDataWriteSummary,
): Promise<void> {
  const usageId = crypto.randomUUID();
  const common = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    sourceResourceType: "site",
    sourceResourceId: caller.siteId,
  };
  if (kind === "upload") {
    await recordUsageEvent(tx, {
      ...common,
      eventType: "site_data.file_upload_bytes",
      quantity: summary.bytesWritten,
      unit: "byte",
      idempotencyKey: `site_data.file_upload_bytes:${usageId}`,
    });
    return;
  }
  await recordUsageEvent(tx, {
    ...common,
    eventType: "site_data.write",
    quantity: summary.operations,
    unit: "operation",
    idempotencyKey: `site_data.write:${usageId}`,
  });
  if (summary.bytesWritten > 0)
    await recordUsageEvent(tx, {
      ...common,
      eventType: "site_data.write_bytes",
      quantity: summary.bytesWritten,
      unit: "byte",
      idempotencyKey: `site_data.write_bytes:${usageId}`,
    });
}

// --- files -----------------------------------------------------------------

const FILE_TYPES: RegExp[] = [
  /^image\/(png|jpeg|gif|webp|avif)$/u,
  /^application\/pdf$/u,
  /^text\/(plain|csv|markdown)$/u,
  /^application\/json$/u,
  /^audio\/(mpeg|mp4|ogg|wav|webm|aac)$/u,
  /^video\/(mp4|webm|ogg|quicktime)$/u,
  /^application\/zip$/u,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/u,
  /^application\/octet-stream$/u,
];

const SIGNATURES: Array<[RegExp, (bytes: Uint8Array) => boolean]> = [
  [/^image\/png$/u, (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  [/^image\/jpeg$/u, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [/^image\/gif$/u, (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  [
    /^image\/webp$/u,
    (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57,
  ],
  [/^application\/pdf$/u, (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46],
];

/** Normalize and check a declared upload type; images and PDFs must match their bytes. */
export function siteDataFileContentType(
  declared: string | null | undefined,
  bytes: Uint8Array,
): string {
  const essence = (declared || "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
  if (!FILE_TYPES.some((pattern) => pattern.test(essence)))
    throw new SiteDataError(
      "validation",
      "This file type is not supported. Use an image, PDF, text, CSV, JSON, audio, video, Office or zip file.",
      { contentType: essence },
    );
  for (const [pattern, matches] of SIGNATURES)
    if (pattern.test(essence) && !matches(bytes))
      throw new SiteDataError("validation", "The file's contents do not match its type", {
        contentType: essence,
      });
  return essence;
}

export function siteDataFileName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "")
    .trim()
    .slice(0, 255);
  if (!cleaned) throw new SiteDataError("validation", "Give the file a name");
  return cleaned;
}

export function siteDataObjectKey(workspaceId: string, siteId: string, fileId: string): string {
  return `workspaces/${workspaceId}/site-data/${siteId}/files/${fileId}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
