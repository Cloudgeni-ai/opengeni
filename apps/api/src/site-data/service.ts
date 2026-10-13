import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import { hasLiteralPermission, hasPermission, siteViewerForGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import type { AccessGrant, SiteDataDescribeResponse } from "@opengeni/contracts";
import {
  createPostgresSiteDataStore,
  getSiteDataAgentSession,
  getSiteDataSite,
  parseSiteDataPath,
  readSiteDataPath,
  recordUsageEvent,
  SiteDataError,
  type Database,
  type SiteDataCaller,
  type SiteDataLimits,
  type SiteDataSite,
  type SiteDataStore,
  type SiteDataWriteOptions,
  type SiteDataWriteSummary,
  writeSiteDataPath,
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
    maxRecordsPerCollection: settings.siteDataMaxRecordsPerCollection,
    viewerWritesPerMinute: settings.siteDataViewerWritesPerMinute,
    siteWritesPerMinute: settings.siteDataSiteWritesPerMinute,
    viewerReadsPerMinute: settings.siteDataViewerReadsPerMinute,
    managerWritesPerMinute: settings.siteDataManagerWritesPerMinute,
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
// defaults or format assertions. Collection schemas use a strict keyword
// allowlist (no references, regexes or conditionals), so compiling and
// validating cost is linear in the schema and the record. Every schema is
// compiled by its own Ajv instance, so nothing registers across tenants, and
// the compiled validators live in a small LRU keyed by the schema's digest:
// evicting an entry frees its Ajv.

const SCHEMA_CACHE_SIZE = 128;
/** Most schema nodes (objects or booleans) a collection schema may have. */
export const SITE_DATA_MAX_SCHEMA_NODES = 100;
/** Most branches one allOf, anyOf or oneOf may have. */
export const SITE_DATA_MAX_SCHEMA_BRANCHES = 16;
/** Most enum values a whole collection schema may list. */
export const SITE_DATA_MAX_SCHEMA_ENUM_TOTAL = 500;
/** Deepest schema nesting a collection schema may have. */
export const SITE_DATA_MAX_SCHEMA_DEPTH = 16;
/** Most values an `enum` may list. */
export const SITE_DATA_MAX_SCHEMA_ENUM = 100;
const compiled = new Map<string, ValidateFunction>();
/** Per-object shortcut so a batch hashes each loaded schema once. */
const compiledByObject = new WeakMap<object, ValidateFunction>();

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const NUMBER_KEYWORDS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const COUNT_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const TEXT_KEYWORDS = new Set(["format", "title", "description"]);
const COMBINATORS = new Set(["allOf", "anyOf", "oneOf"]);
/** Every keyword a collection schema may use. */
export const SITE_DATA_SCHEMA_KEYWORDS: readonly string[] = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  ...NUMBER_KEYWORDS,
  "multipleOf",
  ...COUNT_KEYWORDS,
  ...TEXT_KEYWORDS,
  ...COMBINATORS,
  "uniqueItems",
];
const ALLOWED_KEYWORDS = new Set(SITE_DATA_SCHEMA_KEYWORDS);

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an `items` schema pins every element to scalar types (uniqueItems stays linear). */
function scalarItems(items: unknown): boolean {
  if (!isRecordObject(items)) return false;
  const type = items.type;
  const types = typeof type === "string" ? [type] : Array.isArray(type) ? type : [];
  return types.length > 0 && types.every((entry) => SCALAR_TYPES.has(entry as string));
}

/**
 * Walk a collection schema against the keyword allowlist, counting nodes and
 * depth. Returns the first problem, or null when the schema is supported.
 */
export function siteDataSchemaProblem(schema: unknown): string | null {
  let nodes = 0;
  let enumValues = 0;
  const visit = (node: unknown, path: string, depth: number): string | null => {
    const at = path || "/";
    nodes += 1;
    if (nodes > SITE_DATA_MAX_SCHEMA_NODES)
      return `has more than ${SITE_DATA_MAX_SCHEMA_NODES} schemas`;
    if (depth > SITE_DATA_MAX_SCHEMA_DEPTH)
      return `is nested more than ${SITE_DATA_MAX_SCHEMA_DEPTH} levels deep`;
    if (typeof node === "boolean") return null;
    if (!isRecordObject(node)) return `has a schema at ${at} that is not an object or boolean`;
    for (const [keyword, value] of Object.entries(node)) {
      const where = `${path}/${keyword}`;
      if (!ALLOWED_KEYWORDS.has(keyword))
        return `uses ${keyword} at ${at}, which collection schemas do not support`;
      if (keyword === "type") {
        const types = typeof value === "string" ? [value] : value;
        if (
          !Array.isArray(types) ||
          types.length === 0 ||
          !types.every((type) => SCHEMA_TYPES.has(type as string))
        )
          return `has an invalid type at ${at}`;
      } else if (keyword === "properties") {
        if (!isRecordObject(value)) return `has properties at ${at} that are not an object`;
        for (const [name, child] of Object.entries(value)) {
          const problem = visit(child, `${where}/${name}`, depth + 1);
          if (problem) return problem;
        }
      } else if (keyword === "required") {
        if (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
          return `has required at ${at} that is not a list of names`;
      } else if (keyword === "additionalProperties" || keyword === "items") {
        // `items` is a single schema; tuple forms are not supported.
        const problem = visit(value, where, depth + 1);
        if (problem) return problem;
      } else if (keyword === "enum") {
        if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar))
          return `has an enum at ${at} that is not a list of strings, numbers, booleans or null`;
        if (value.length > SITE_DATA_MAX_SCHEMA_ENUM)
          return `has an enum at ${at} with more than ${SITE_DATA_MAX_SCHEMA_ENUM} values`;
        enumValues += value.length;
        if (enumValues > SITE_DATA_MAX_SCHEMA_ENUM_TOTAL)
          return `lists more than ${SITE_DATA_MAX_SCHEMA_ENUM_TOTAL} enum values in total`;
      } else if (keyword === "const") {
        if (!isScalar(value)) return `has a const at ${at} that is not a scalar`;
      } else if (NUMBER_KEYWORDS.has(keyword)) {
        if (typeof value !== "number" || !Number.isFinite(value))
          return `has ${keyword} at ${at} that is not a number`;
      } else if (keyword === "multipleOf") {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
          return `has multipleOf at ${at} that is not a positive number`;
      } else if (COUNT_KEYWORDS.has(keyword)) {
        if (!Number.isSafeInteger(value) || (value as number) < 0)
          return `has ${keyword} at ${at} that is not a non-negative integer`;
      } else if (TEXT_KEYWORDS.has(keyword)) {
        if (typeof value !== "string") return `has ${keyword} at ${at} that is not text`;
      } else if (COMBINATORS.has(keyword)) {
        if (!Array.isArray(value) || value.length === 0)
          return `has ${keyword} at ${at} that is not a list of schemas`;
        if (value.length > SITE_DATA_MAX_SCHEMA_BRANCHES)
          return `has ${keyword} at ${at} with more than ${SITE_DATA_MAX_SCHEMA_BRANCHES} schemas`;
        for (const [index, child] of value.entries()) {
          const problem = visit(child, `${where}/${index}`, depth + 1);
          if (problem) return problem;
        }
      } else if (keyword === "uniqueItems") {
        if (typeof value !== "boolean") return `has uniqueItems at ${at} that is not a boolean`;
        if (value && !scalarItems(node.items))
          return `uses uniqueItems at ${at} without scalar items (give items a string, number, integer, boolean or null type)`;
      }
    }
    return null;
  };
  return visit(schema, "", 0);
}

function compileSiteDataSchema(schema: Record<string, unknown>): ValidateFunction {
  const known = compiledByObject.get(schema);
  if (known) return known;
  const problem = siteDataSchemaProblem(schema);
  if (problem) throw new SiteDataError("validation", `jsonSchema ${problem}`);
  const digest = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  let validator = compiled.get(digest);
  if (validator) compiled.delete(digest);
  else {
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
  }
  compiled.set(digest, validator);
  while (compiled.size > SCHEMA_CACHE_SIZE) compiled.delete(compiled.keys().next().value!);
  compiledByObject.set(schema, validator);
  return validator;
}

/** Compiled validators currently cached (for tests). */
export function siteDataSchemaCacheSize(): number {
  return compiled.size;
}

function runValidator(validator: ValidateFunction, data: Record<string, unknown>): string | null {
  if (validator(data)) return null;
  const issue = validator.errors?.[0];
  return issue
    ? `${issue.instancePath || "record"} ${issue.message ?? "is invalid"}`
    : "record is invalid";
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
  return runValidator(validator, data);
}

/** Check a collection's JSON Schema is supported and compiles before it is stored. */
export function assertSiteDataSchema(schema: Record<string, unknown> | null | undefined): void {
  if (!schema) return;
  compileSiteDataSchema(schema);
}

/** Total record JSON one write, batch or import request may carry. */
export const SITE_DATA_MAX_REQUEST_RECORD_BYTES = 4 * 1024 * 1024;
/** Schema validation time one request may spend, checked between records. */
export const SITE_DATA_VALIDATION_BUDGET_MS = 250;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

function recordRef(op: Record<string, unknown>): { id: string } | { key: string } | null {
  if (typeof op.id === "string") return { id: op.id };
  if (typeof op.key === "string") return { key: op.key };
  return null;
}

/**
 * The record a patch or increment would produce from the stored record, the
 * same way the store merges it, or null when the store decides (missing
 * record, bad field, non-number).
 */
function mergedRecord(
  op: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (op.op === "patch")
    return stored && isRecordObject(op.data) ? { ...stored, ...op.data } : null;
  if (op.op !== "increment" || typeof op.field !== "string") return null;
  const segments = parseSiteDataPath(op.field);
  const by = op.by ?? 1;
  if (!segments || typeof by !== "number" || !Number.isFinite(by)) return null;
  if (!stored) return typeof op.key === "string" ? writeSiteDataPath({}, segments, by) : null;
  const current = readSiteDataPath(stored, segments);
  if (current !== undefined && current !== null && typeof current !== "number") return null;
  return writeSiteDataPath(stored, segments, ((current as number | null) ?? 0) + by);
}

function contentDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

/**
 * Check a write, batch or import before the store takes the Site's lock:
 *
 * - its records total at most 4 MB of JSON (`quota_exceeded`, `request_bytes`);
 * - every insert and put record matches its collection's schema;
 * - every patch and increment result, merged from the stored record, matches
 *   too (if the record changes before the lock, the write checks it again);
 * - schema validation spends at most 250 ms per request, measured between
 *   records, yielding to the event loop after each one.
 *
 * Returns write options that skip re-validating the records already checked
 * against the same schema, and that keep any check left for inside the write
 * on the same time budget.
 */
export async function prevalidateSiteDataWrite(
  access: Pick<SiteDataAccess, "store" | "caller" | "limits" | "writeOptions">,
  operations: readonly unknown[],
  budgetMs: number = SITE_DATA_VALIDATION_BUDGET_MS,
): Promise<SiteDataWriteOptions> {
  let requestBytes = 0;
  for (const op of operations)
    if (isRecordObject(op) && op.data !== undefined) requestBytes += jsonBytes(op.data);
  if (requestBytes > SITE_DATA_MAX_REQUEST_RECORD_BYTES)
    throw new SiteDataError(
      "quota_exceeded",
      `One request can carry at most ${SITE_DATA_MAX_REQUEST_RECORD_BYTES / 1024 / 1024} MB of records; send them in smaller requests`,
      { quota: "request_bytes", limit: SITE_DATA_MAX_REQUEST_RECORD_BYTES },
    );
  let spentMs = 0;
  const overBudget = (index?: number) =>
    new SiteDataError(
      "validation",
      "Checking these records against the collection schema took too long; send fewer or smaller records per request",
      { reason: "validation_budget", budgetMs, ...(index === undefined ? {} : { index }) },
    );
  const timed = (validator: ValidateFunction, data: Record<string, unknown>) => {
    const started = performance.now();
    try {
      return runValidator(validator, data);
    } finally {
      spentMs += performance.now() - started;
    }
  };
  const schemas = new Map<string, Record<string, unknown> | null>();
  const validated = new WeakMap<object, ValidateFunction>();
  const validatedMerges = new Map<string, ValidateFunction>();
  for (const [index, op] of operations.entries()) {
    if (!isRecordObject(op) || typeof op.collection !== "string") continue;
    if (!schemas.has(op.collection)) {
      const collection = await access.store.getCollection(access.caller, op.collection);
      schemas.set(op.collection, collection?.jsonSchema ?? null);
    }
    const schema = schemas.get(op.collection);
    if (!schema) continue;
    let validator: ValidateFunction;
    try {
      validator = compileSiteDataSchema(schema);
    } catch {
      continue; // The store reports the invalid schema.
    }
    if (op.op === "insert" || op.op === "put") {
      if (!isRecordObject(op.data)) continue;
      // Oversized records are refused by the store's size check instead.
      if (jsonBytes(op.data) > access.limits.maxRecordBytes) continue;
      const problem = timed(validator, op.data);
      if (problem)
        throw new SiteDataError(
          "validation",
          `Record does not match the collection schema: ${problem}`,
          { index },
        );
      validated.set(op.data, validator);
    } else if (op.op === "patch" || op.op === "increment") {
      const ref = recordRef(op);
      if (!ref) continue;
      const stored = await access.store.get(access.caller, op.collection, ref).catch(() => null);
      const merged = mergedRecord(op, stored ? stored.data : null);
      if (!merged || jsonBytes(merged) > access.limits.maxRecordBytes) continue;
      // An invalid result is left to the write, which sees the current record.
      if (timed(validator, merged) === null) validatedMerges.set(contentDigest(merged), validator);
    } else continue;
    if (spentMs > budgetMs) throw overBudget(index);
    await yieldToEventLoop();
  }
  return {
    ...access.writeOptions,
    validate: (schema, data) => {
      let validator: ValidateFunction;
      try {
        validator = compileSiteDataSchema(schema);
      } catch {
        return "the collection's JSON Schema is invalid";
      }
      if (validated.get(data) === validator) return null;
      if (validatedMerges.size > 0 && validatedMerges.get(contentDigest(data)) === validator)
        return null;
      // Anything left for inside the write stays on the request's budget.
      if (spentMs > budgetMs) throw overBudget();
      return timed(validator, data);
    },
  };
}

/** The worker-signed session an agent grant acts in, if any. */
function agentSessionIds(grant: AccessGrant): { sessionId: string; turnId: string | null } | null {
  if (grant.principalKind !== "agent_attempt" && grant.metadata?.delegated !== true) return null;
  const sessionId = grant.metadata?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const turnId = grant.metadata?.turnId;
  return { sessionId, turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null };
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
 * A person-less agent owns records as its scheduled task when a schedule's
 * run created its session (`schedule:<taskId>`, stable across runs), and as
 * its own session otherwise (`agent:session:<sessionId>`).
 */
export function siteDataPrincipal(
  grant: AccessGrant,
  subjectId: string | null,
  scheduledTaskId: string | null = null,
): string {
  if (subjectId) return `user:${subjectId}`;
  if (grant.principalKind === "agent_attempt" || agentSessionIds(grant)) {
    return scheduledTaskId ? `schedule:${scheduledTaskId}` : agentPrincipal(grant);
  }
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
 * Managers may manage the Site's data, each with `artifacts:publish`: its
 * owner, a workspace admin, an agent acting for one of those people, or a
 * person-less workspace API key, configured key or service credential. A Site
 * without an owner is managed by its creator. An agent without a person (for
 * example a person-less scheduled task) is a viewer, whatever credential
 * started it. Agents whose session came from a Site page are clamped to that
 * Site's viewer rules in resolveSiteDataAccess.
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
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  // An agent whose session (or spawning lineage, or current turn) came from a
  // Site page acts for that page: it gets the same frame clamp as the page.
  // A lineage that cannot be read in full fails closed to viewer reach.
  const agentIds = agentSessionIds(grant);
  const agentSession = agentIds
    ? await getSiteDataAgentSession(deps.db, scope, agentIds.sessionId, agentIds.turnId)
    : null;
  const siteAgent =
    agentSession !== null &&
    (agentSession.originSiteIds.length > 0 || agentSession.siteTurn || !agentSession.complete);
  if (siteAgent) {
    const [origin, ...others] = agentSession.originSiteIds;
    const knownSite = origin !== undefined && others.length === 0;
    // A known Site origin limits the agent to that Site. A Site turn without
    // one known origin reaches no Site Data; an unreadable lineage without a
    // known origin keeps viewer reach on the Site it names.
    if (
      others.length > 0 ||
      (knownSite && origin !== siteId) ||
      (!knownSite && agentSession.siteTurn)
    )
      throw new SiteDataError(
        "forbidden",
        "An agent started from a Site page can only use that Site's data",
      );
    if (surface.management)
      throw new SiteDataError(
        "forbidden",
        agentSession.complete
          ? "An agent started from a Site page cannot manage Site Data"
          : "This agent's session history could not be confirmed, so it cannot manage Site Data",
      );
  }
  const framed = siteAgent || (surface.frameSiteId !== undefined && surface.frameSiteId !== null);
  if (surface.frameSiteId != null && surface.frameSiteId !== siteId)
    throw new SiteDataError("forbidden", "A Site can only use its own data");
  const viewer = await siteViewerForGrant(deps.db, grant);
  const site = await getSiteDataSite(deps.db, scope, viewer, siteId);
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
    principal: siteDataPrincipal(grant, viewer.subjectId, agentSession?.scheduledTaskId ?? null),
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
