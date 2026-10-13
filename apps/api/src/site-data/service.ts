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
  /** Whether requests count against the per-minute windows. */
  rateLimited: boolean;
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
    maxRecordsPerCollection: settings.siteDataMaxRecordsPerCollection,
    viewerWritesPerMinute: settings.siteDataViewerWritesPerMinute,
    siteWritesPerMinute: settings.siteDataSiteWritesPerMinute,
    viewerReadsPerMinute: settings.siteDataViewerReadsPerMinute,
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
// defaults or format assertions. Every schema is compiled by its own Ajv
// instance, so `$id`s never register across tenants, and the compiled
// validators live in a small LRU keyed by the schema's digest: evicting an
// entry frees its Ajv. Regex keywords are refused (no RE2 here), and so are
// identifiers and references that could reach outside the schema.

const SCHEMA_CACHE_SIZE = 128;
const compiled = new Map<string, ValidateFunction>();

/** Keywords refused anywhere in a collection's JSON Schema. */
const FORBIDDEN_SCHEMA_KEYWORDS = new Set([
  "$id",
  "id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveRef",
  "$recursiveAnchor",
  "$schema",
  "$async",
  "pattern",
  "patternProperties",
]);
/** Keywords whose value is a map from names to schemas. */
const SCHEMA_MAPS = new Set([
  "properties",
  "definitions",
  "$defs",
  "dependentSchemas",
  "dependencies",
]);
/** Keywords whose value is data, not a schema. */
const SCHEMA_DATA = new Set([
  "enum",
  "const",
  "default",
  "examples",
  "required",
  "dependentRequired",
]);

function schemaProblem(node: unknown, path: string, depth: number): string | null {
  if (depth > 32) return "is nested too deeply";
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const problem = schemaProblem(item, `${path}/${index}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  for (const [keyword, value] of Object.entries(node)) {
    // `id` is only a keyword when it names a schema (a string); as a property name it is fine.
    if (FORBIDDEN_SCHEMA_KEYWORDS.has(keyword) && (keyword !== "id" || typeof value === "string"))
      return `uses ${keyword} at ${path || "/"}, which collection schemas do not support`;
    if (keyword === "$ref") {
      if (typeof value !== "string" || !(value === "#" || value.startsWith("#/")))
        return `has a $ref at ${path || "/"} that is not local (only #/... references work)`;
      continue;
    }
    if (SCHEMA_DATA.has(keyword)) continue;
    if (SCHEMA_MAPS.has(keyword) && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, schema] of Object.entries(value)) {
        const problem = schemaProblem(schema, `${path}/${keyword}/${name}`, depth + 1);
        if (problem) return problem;
      }
      continue;
    }
    const problem = schemaProblem(value, `${path}/${keyword}`, depth + 1);
    if (problem) return problem;
  }
  return null;
}

function compileSiteDataSchema(schema: Record<string, unknown>): ValidateFunction {
  const problem = schemaProblem(schema, "", 0);
  if (problem) throw new SiteDataError("validation", `jsonSchema ${problem}`);
  const digest = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const cached = compiled.get(digest);
  if (cached) {
    compiled.delete(digest);
    compiled.set(digest, cached);
    return cached;
  }
  let validator: ValidateFunction;
  try {
    validator = new Ajv({
      allErrors: false,
      coerceTypes: false,
      strict: false,
      useDefaults: false,
      validateFormats: false,
      addUsedSchema: false,
    }).compile(schema);
  } catch (error) {
    throw new SiteDataError(
      "validation",
      `jsonSchema is not a valid JSON Schema: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
  compiled.set(digest, validator);
  while (compiled.size > SCHEMA_CACHE_SIZE) compiled.delete(compiled.keys().next().value!);
  return validator;
}

/** Compiled validators currently cached (for tests). */
export function siteDataSchemaCacheSize(): number {
  return compiled.size;
}

export function validateSiteDataRecord(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): string | null {
  let validator: ValidateFunction;
  try {
    validator = compileSiteDataSchema(schema);
  } catch {
    return "the collection's JSON Schema is invalid";
  }
  if (validator(data)) return null;
  const issue = validator.errors?.[0];
  return issue
    ? `${issue.instancePath || "record"} ${issue.message ?? "is invalid"}`
    : "record is invalid";
}

/** Check a collection's JSON Schema is supported and compiles before it is stored. */
export function assertSiteDataSchema(schema: Record<string, unknown> | null | undefined): void {
  if (!schema) return;
  compileSiteDataSchema(schema);
}

/**
 * Compile the schemas of the collections a write touches before the store
 * takes the Site's lock, so the lock is never held while compiling.
 */
export async function warmSiteDataSchemas(
  access: Pick<SiteDataAccess, "store" | "caller">,
  collections: Iterable<string>,
): Promise<void> {
  for (const name of new Set(collections)) {
    if (typeof name !== "string") continue;
    const collection = await access.store.getCollection(access.caller, name);
    if (collection?.jsonSchema) {
      try {
        compileSiteDataSchema(collection.jsonSchema);
      } catch {
        // The write reports the invalid schema itself.
      }
    }
  }
}

/** A stable principal for an agent session: its own, distinct from any person. */
function agentPrincipal(grant: AccessGrant): string {
  const sessionId = grant.metadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? `agent:session:${sessionId}`
    : `agent:${grant.subjectId}`;
}

/**
 * The record owner: the person, or the person an agent or schedule acts for.
 * An agent without a person owns records as its own session.
 */
export function siteDataPrincipal(grant: AccessGrant, subjectId: string | null): string {
  if (subjectId) return `user:${subjectId}`;
  if (grant.principalKind === "agent_attempt") return agentPrincipal(grant);
  return `service:${grant.subjectId}`;
}

/** The writer recorded on records: agents are distinct from the person they act for. */
export function siteDataActor(grant: AccessGrant, subjectId: string | null): string {
  if (grant.principalKind === "agent_attempt") return agentPrincipal(grant);
  return siteDataPrincipal(grant, subjectId);
}

/** Personless credentials that may manage data with publish permission. */
const PERSONLESS_MANAGER_KINDS = new Set(["api_key", "configured_key", "service"]);

/**
 * Managers may manage the Site's data: its owner, a workspace admin, a
 * workspace API key, configured key or service without a person, or an agent
 * acting for one of them, each with `artifacts:publish`. A Site without an
 * owner is managed by its creator. Any other grant without a resolved person
 * (for example an agent whose session has no person) is a viewer.
 */
export function siteDataRole(
  grant: AccessGrant,
  site: Pick<SiteDataSite, "ownerSubjectId" | "createdBySubjectId">,
  subjectId: string | null,
): "manager" | "viewer" {
  if (!hasPermission(grant.permissions, "artifacts:publish", grant.permissionMode)) return "viewer";
  if (hasLiteralPermission(grant.permissions, "workspace:admin")) return "manager";
  if (subjectId === null)
    return grant.principalKind !== undefined && PERSONLESS_MANAGER_KINDS.has(grant.principalKind)
      ? "manager"
      : "viewer";
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
  // Site HTML is untrusted: whoever views it, a Site frame gets viewer reach.
  // Managers keep full reach only through the Data view, the API and agent tools.
  const manages = siteDataRole(grant, site, viewer.subjectId) === "manager";
  const role = framed ? "viewer" : manages ? "manager" : "viewer";
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
    // Managers' own tools and API calls are bounded by quotas, not windows.
    rateLimited: role !== "manager",
    writeOptions: {
      limits,
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
