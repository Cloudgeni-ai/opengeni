import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  APP_WEBHOOK_DELIVERIES_PER_MINUTE,
  APP_WEBHOOK_MAX_RECORDS,
  APP_WEBHOOK_SIGNATURE_HEADER,
  APP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  AppWebhookCreateRequest,
  AppWebhookUpdateRequest,
  type AccessGrant,
  type AppWebhook,
  type AppWebhookDeliveryResponse,
  type AppWebhookSaveResponse,
} from "@opengeni/contracts";
import { inboundWebhookBaseUrl, verifyTimestampedHmac } from "@opengeni/core";
import {
  admitAppWebhookDelivery,
  createAppWebhook as insertAppWebhook,
  decryptEnvironmentValue,
  deleteAppWebhook as removeAppWebhook,
  encryptEnvironmentValue,
  getAppWebhook,
  getWorkspaceGrant,
  listAppWebhooks as readAppWebhooks,
  recordAppWebhookDelivery,
  SiteDataError,
  subjectHasLiveWorkspaceAuthorityInScope,
  updateAppWebhook as writeAppWebhook,
  withWorkspaceSubjectRls,
  type AppWebhookRow,
  type AppWebhookSettings,
  type SiteDataCaller,
  type SiteDataWriteOp,
} from "@opengeni/db";
import { appSyncRecords, readPath, writePath } from "../app-sync/service";
import { writeSiteDataWithAccess } from "../site-data/operations";
import {
  meterSiteData,
  resolveSiteDataAccess,
  siteDataLimits,
  siteDataStore,
  validateSiteDataRecord,
  type SiteDataAccess,
  type SiteDataDeps,
} from "../site-data/service";
import { errorMessage } from "@opengeni/contracts/values";
import type { z } from "zod";

/**
 * Webhooks into apps (docs/app-webhooks.md). An app's webhook is an address
 * on the API that turns each delivery into records of one shared collection
 * of the app's data, through the ordinary Site Data write path: the same
 * validation, quotas, rate windows, metering and change events (live
 * updates, automations and workspace webhooks) as any other write. The
 * webhook writes as its own principal (`webhook:<id>`), a trusted
 * manager-level writer, into shared collections only.
 */

/** Where deliveries arrive: `/v1/webhooks/apps/<workspaceId>/<webhookId>`. */
export const APP_WEBHOOK_PATH_PREFIX = "/v1/webhooks/apps/";

/** A webhook delivery counts as one automated hop on the change events it causes. */
export const APP_WEBHOOK_CHAIN_DEPTH = 1;

const SECRET_PREFIX = "ogwh_";

const forbidden = (message: string, details?: Record<string, unknown>) =>
  new SiteDataError("forbidden", message, details);
const invalid = (message: string, details?: Record<string, unknown>) =>
  new SiteDataError("validation", message, details);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encryptionKey(deps: SiteDataDeps): Uint8Array {
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key)
    throw forbidden(
      "App webhooks need OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY on this deployment to keep their secrets.",
      { reason: "app_webhooks_unavailable" },
    );
  return key;
}

function newSecret(deps: SiteDataDeps) {
  const secret = `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    secretHash: sha256Hex(secret),
    secretEncrypted: encryptEnvironmentValue(encryptionKey(deps), secret),
  };
}

/** The public address of a webhook, or null without a public base address. */
export function appWebhookUrl(
  settings: SiteDataDeps["settings"],
  requestUrl: string | null,
  row: Pick<AppWebhookRow, "workspaceId" | "id">,
): string | null {
  let base = inboundWebhookBaseUrl(settings) ?? null;
  if (!base && requestUrl) {
    try {
      base = new URL(requestUrl).origin;
    } catch {
      base = null;
    }
  }
  return base
    ? `${base.replace(/\/+$/u, "")}${APP_WEBHOOK_PATH_PREFIX}${row.workspaceId}/${row.id}`
    : null;
}

function viewOf(row: AppWebhookRow, url: string | null): AppWebhook {
  return {
    id: row.id,
    appId: row.siteId,
    name: row.name,
    collection: row.collection,
    recordsPath: row.recordsPath,
    key: row.key,
    fields: row.fields,
    status: row.status,
    url,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastDeliveryAt: row.lastDeliveryAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
  };
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  throw invalid(
    parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`)
      .join("; "),
  );
}

/** A manager of the app, outside its frame (the HTTP routes refuse framed calls first). */
async function managerAccess(deps: SiteDataDeps, grant: AccessGrant, siteId: string) {
  return await resolveSiteDataAccess(deps, grant, siteId, { management: true });
}

/** A webhook fills a collection everyone in the app shares, never one person's records. */
async function requireSharedCollection(access: SiteDataAccess, name: string): Promise<void> {
  const collection = await access.store.getCollection(
    {
      accountId: access.caller.accountId,
      workspaceId: access.caller.workspaceId,
      siteId: access.site.id,
    },
    name,
  );
  if (!collection)
    throw invalid(`The app has no collection named "${name}". Define it first.`, {
      code: "collection_not_found",
    });
  if (collection.accessMode === "per_viewer")
    throw invalid(
      `"${name}" keeps each person's records separately, so a webhook can't fill it. Use a shared, shared_read or append_only collection.`,
      { reason: "collection_per_viewer" },
    );
}

/**
 * A webhook writes on the authority of the person who last saved it, so a
 * person (or their agent) saves it, and deliveries stop when that person can
 * no longer manage the app.
 */
function creatorOf(access: SiteDataAccess): string {
  if (!access.subjectId)
    throw forbidden(
      "A webhook writes on a person's authority, so a person (or their agent) must save it.",
      { reason: "person_required" },
    );
  return access.subjectId;
}

export async function listAppWebhooks(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  requestUrl: string | null = null,
): Promise<AppWebhook[]> {
  const access = await managerAccess(deps, grant, siteId);
  const rows = await readAppWebhooks(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    access.site.id,
  );
  return rows.map((row) => viewOf(row, appWebhookUrl(deps.settings, requestUrl, row)));
}

export async function createAppWebhook(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  body: unknown,
  requestUrl: string | null = null,
): Promise<AppWebhookSaveResponse> {
  const request = parse(AppWebhookCreateRequest, body);
  const access = await managerAccess(deps, grant, siteId);
  if (access.site.status !== "active") throw forbidden("This app is archived");
  await requireSharedCollection(access, request.collection);
  const secret = newSecret(deps);
  const row = await insertAppWebhook(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    {
      siteId: access.site.id,
      name: request.name,
      collection: request.collection,
      recordsPath: request.recordsPath ?? null,
      key: request.key ?? null,
      fields: request.fields ?? null,
      status: request.status ?? "active",
      secretHash: secret.secretHash,
      secretEncrypted: secret.secretEncrypted,
      createdBySubjectId: creatorOf(access),
    },
  );
  if (row === "limit")
    throw new SiteDataError("quota_exceeded", "An app has at most 20 webhooks. Delete one first.");
  return {
    webhook: viewOf(row, appWebhookUrl(deps.settings, requestUrl, row)),
    secret: secret.secret,
  };
}

async function requireWebhook(
  deps: SiteDataDeps,
  grant: AccessGrant,
  access: SiteDataAccess,
  webhookId: string,
): Promise<AppWebhookRow> {
  const row = UUID.test(webhookId)
    ? await getAppWebhook(deps.db, grant.workspaceId, webhookId)
    : null;
  if (!row || row.siteId !== access.site.id)
    throw new SiteDataError("not_found", "Webhook not found");
  return row;
}

export async function updateAppWebhook(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  webhookId: string,
  body: unknown,
  requestUrl: string | null = null,
): Promise<AppWebhookSaveResponse> {
  const request = parse(AppWebhookUpdateRequest, body);
  const access = await managerAccess(deps, grant, siteId);
  const current = await requireWebhook(deps, grant, access, webhookId);
  const creator = creatorOf(access);
  const next: AppWebhookSettings = {
    name: request.name ?? current.name,
    collection: request.collection ?? current.collection,
    recordsPath: request.recordsPath !== undefined ? request.recordsPath : current.recordsPath,
    key: request.key !== undefined ? request.key : current.key,
    fields: request.fields !== undefined ? request.fields : current.fields,
    status: request.status ?? current.status,
  };
  if (next.collection !== current.collection)
    await requireSharedCollection(access, next.collection);
  const secret = request.rotateSecret === true ? newSecret(deps) : null;
  const row = await writeAppWebhook(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    current.id,
    {
      ...next,
      createdBySubjectId: creator,
      ...(secret ? { secretHash: secret.secretHash, secretEncrypted: secret.secretEncrypted } : {}),
    },
  );
  if (!row) throw new SiteDataError("not_found", "Webhook not found");
  return {
    webhook: viewOf(row, appWebhookUrl(deps.settings, requestUrl, row)),
    ...(secret ? { secret: secret.secret } : {}),
  };
}

export async function deleteAppWebhook(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  webhookId: string,
): Promise<{ deleted: boolean }> {
  const access = await managerAccess(deps, grant, siteId);
  const current = await requireWebhook(deps, grant, access, webhookId);
  return {
    deleted: await removeAppWebhook(
      deps.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      current.id,
    ),
  };
}

// --- deliveries -----------------------------------------------------------------

export type AppWebhookIntakeResult =
  | { outcome: "not_found" }
  | { outcome: "rejected"; status: 401 | 403 | 409 | 413 | 415 | 429; reason: string }
  | { outcome: "invalid"; reason: string }
  | { outcome: "written"; result: AppWebhookDeliveryResponse };

function constantTimeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.byteLength === b.byteLength && a.byteLength > 0 && timingSafeEqual(a, b);
}

/**
 * The sender proves it holds the secret: as `Authorization: Bearer <secret>`,
 * or with `X-Opengeni-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>" keyed with the secret>` within five minutes of now.
 */
export function verifyAppWebhookDelivery(input: {
  row: Pick<AppWebhookRow, "secretHash" | "secretEncrypted">;
  headers: Headers;
  body: Uint8Array;
  decrypt: (stored: string) => string;
  nowSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  const authorization = input.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)\s*$/iu.exec(authorization);
    if (match && constantTimeHexEqual(sha256Hex(match[1]!), input.row.secretHash))
      return { ok: true };
    return { ok: false, reason: "The bearer token is not this webhook's secret" };
  }
  const signature = input.headers.get(APP_WEBHOOK_SIGNATURE_HEADER);
  if (signature !== null) {
    const verified = verifyTimestampedHmac({
      secret: input.decrypt(input.row.secretEncrypted),
      header: APP_WEBHOOK_SIGNATURE_HEADER,
      value: signature,
      body: input.body,
      toleranceSeconds: APP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      nowSeconds: input.nowSeconds,
    });
    return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
  }
  return {
    ok: false,
    reason: `Send the secret as "Authorization: Bearer <secret>" or sign the body in ${APP_WEBHOOK_SIGNATURE_HEADER}`,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A signed delivery's id comes from its signature (which covers the time and
 * the body), so replaying it inside the signature window, or changing an
 * unsigned id header, can't insert its records again.
 */
function signedDeliveryId(headers: Headers): string | null {
  if (headers.get("authorization") !== null) return null;
  const signature = headers.get(APP_WEBHOOK_SIGNATURE_HEADER)?.trim();
  return signature ? `sig:${sha256Hex(signature)}` : null;
}

/** A sender's delivery id, for idempotent inserts. */
function deliveryIdOf(headers: Headers): string | null {
  for (const name of ["idempotency-key", "webhook-id", "x-delivery-id"]) {
    const value = headers.get(name)?.trim();
    if (value && /^[\x21-\x7e]{1,200}$/u.test(value)) return value;
  }
  return null;
}

/** The write operations one delivery makes, with the mapping a data sync uses. */
export function appWebhookOperations(
  value: unknown,
  mapping: Pick<AppWebhookRow, "collection" | "recordsPath" | "key" | "fields">,
  deliveryId: string | null,
): { operations: SiteDataWriteOp[]; skipped: number } {
  let list: unknown[];
  if (mapping.recordsPath) {
    const found = readPath(value, mapping.recordsPath);
    if (found === undefined) throw invalid(`The body has nothing at "${mapping.recordsPath}".`);
    list = Array.isArray(found) ? found : [found];
  } else list = Array.isArray(value) ? value : [value];
  if (list.length > APP_WEBHOOK_MAX_RECORDS)
    throw invalid(`A delivery writes at most ${APP_WEBHOOK_MAX_RECORDS} records.`);
  if (mapping.key) {
    const extracted = appSyncRecords(list, {
      recordsPath: null,
      key: mapping.key,
      fields: mapping.fields,
    });
    return {
      operations: extracted.records.map((record) => ({
        op: "put",
        collection: mapping.collection,
        key: record.key,
        data: record.data,
      })),
      skipped: extracted.skipped,
    };
  }
  const operations: SiteDataWriteOp[] = [];
  let skipped = 0;
  list.forEach((item, index) => {
    if (!isObject(item)) {
      skipped += 1;
      return;
    }
    let data: Record<string, unknown> = item;
    if (mapping.fields && mapping.fields.length > 0) {
      data = {};
      for (const field of mapping.fields) {
        const fieldValue = readPath(item, field);
        if (fieldValue !== undefined) writePath(data, field, fieldValue);
      }
    }
    operations.push({
      op: "insert",
      collection: mapping.collection,
      data,
      ...(deliveryId
        ? { idempotencyKey: list.length === 1 ? deliveryId : `${deliveryId}:${index}` }
        : {}),
    });
  });
  return { operations, skipped };
}

const CREATOR_CANNOT_MANAGE =
  "The person who saved this webhook can no longer manage the app. Someone who manages it should save the webhook again.";

/** The creator's live grant, as when they use Opengeni themselves; null once they're gone. */
async function creatorGrant(deps: SiteDataDeps, row: AppWebhookRow): Promise<AccessGrant | null> {
  const scope = { accountId: row.accountId, workspaceId: row.workspaceId };
  const subjectId = row.createdBySubjectId;
  return await withWorkspaceSubjectRls(deps.db, row.workspaceId, subjectId, async (tx) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, { ...scope, subjectId }))) return null;
    return await getWorkspaceGrant(tx, subjectId, row.workspaceId, {
      principalKind: "human_session",
    });
  });
}

/**
 * The access a delivery writes with: the webhook's own trusted principal,
 * while the person who saved it is still a live member who manages the app
 * (the rule shared syncs follow). An archived app refuses deliveries.
 */
async function deliveryAccess(deps: SiteDataDeps, row: AppWebhookRow): Promise<SiteDataAccess> {
  const scope = { accountId: row.accountId, workspaceId: row.workspaceId };
  const refused = () => forbidden(CREATOR_CANNOT_MANAGE, { reason: "creator_cannot_manage" });
  const grant = await creatorGrant(deps, row);
  if (!grant) throw refused();
  let creator: SiteDataAccess;
  try {
    creator = await resolveSiteDataAccess(deps, grant, row.siteId);
  } catch (error) {
    if (
      error instanceof SiteDataError &&
      (error.code === "forbidden" || error.code === "not_found")
    )
      throw refused();
    throw error;
  }
  const site = creator.site;
  if (site.status !== "active")
    throw forbidden("The app is archived, so its webhooks refuse deliveries.");
  if (creator.caller.role !== "manager") throw refused();
  const principal = `webhook:${row.id}`;
  const caller: SiteDataCaller = {
    ...scope,
    siteId: site.id,
    role: "manager",
    principal,
    actor: principal,
    framed: false,
    chainDepth: APP_WEBHOOK_CHAIN_DEPTH,
  };
  const limits = siteDataLimits(deps.settings);
  return {
    site,
    caller,
    subjectId: null,
    store: siteDataStore(deps.db, deps.settings),
    limits,
    writeOptions: {
      limits,
      validate: validateSiteDataRecord,
      afterWrite: (tx, summary) => meterSiteData(tx, scope, caller, null, "write", summary),
    },
  };
}

function isJson(contentType: string | null): boolean {
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/u.test(type);
}

/**
 * One delivery. Nothing is parsed before the secret is checked over the exact
 * raw body. A paused webhook, an archived app and a full delivery window
 * refuse it; otherwise its records are written and its outcome kept on the
 * webhook for the people managing it.
 */
export async function receiveAppWebhook(
  deps: SiteDataDeps,
  input: {
    workspaceId: string;
    webhookId: string;
    headers: Headers;
    body: Uint8Array;
    now?: Date;
  },
): Promise<AppWebhookIntakeResult> {
  const row = await getAppWebhook(deps.db, input.workspaceId, input.webhookId);
  if (!row) return { outcome: "not_found" };
  const scope = { accountId: row.accountId, workspaceId: row.workspaceId };
  const remember = async (status: "succeeded" | "failed" | "rejected", error: string | null) => {
    await recordAppWebhookDelivery(deps.db, scope, row.id, { status, error }).catch(
      (failure: unknown) =>
        console.warn("[app-webhooks] could not record a delivery", {
          webhookId: row.id,
          error: errorMessage(failure),
        }),
    );
  };
  let verification: { ok: true } | { ok: false; reason: string };
  try {
    verification = verifyAppWebhookDelivery({
      row,
      headers: input.headers,
      body: input.body,
      decrypt: (stored) => decryptEnvironmentValue(encryptionKey(deps), stored),
      nowSeconds: Math.floor((input.now ?? new Date()).getTime() / 1000),
    });
  } catch {
    // A deployment problem the managers need to see; kept on the webhook.
    const reason = "This webhook's secret can't be read on this deployment";
    await remember("rejected", reason);
    return { outcome: "rejected", status: 401, reason };
  }
  // Anyone who knows the address can send unauthenticated requests, so they
  // write nothing (not even the webhook's last-delivery status).
  if (!verification.ok) return { outcome: "rejected", status: 401, reason: verification.reason };
  if (row.status !== "active") {
    await remember("rejected", "The webhook is paused");
    return { outcome: "rejected", status: 409, reason: "This webhook is paused" };
  }
  if (!(await admitAppWebhookDelivery(deps.db, scope, row.id, APP_WEBHOOK_DELIVERIES_PER_MINUTE)))
    return {
      outcome: "rejected",
      status: 429,
      reason: `A webhook accepts at most ${APP_WEBHOOK_DELIVERIES_PER_MINUTE} deliveries a minute`,
    };
  if (!isJson(input.headers.get("content-type"))) {
    await remember("failed", "The body must be JSON (Content-Type: application/json)");
    return { outcome: "rejected", status: 415, reason: "The body must be JSON" };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    await remember("failed", "The body is not valid JSON");
    return { outcome: "invalid", reason: "The body is not valid JSON" };
  }
  try {
    const access = await deliveryAccess(deps, row);
    await requireSharedCollection(access, row.collection);
    const { operations, skipped } = appWebhookOperations(
      value,
      row,
      signedDeliveryId(input.headers) ?? deliveryIdOf(input.headers),
    );
    const written =
      operations.length === 0
        ? { results: [] }
        : await writeSiteDataWithAccess(deps, access, operations);
    const records = written.results.flatMap((item) =>
      "record" in item ? [{ id: item.record.id, key: item.record.key ?? null }] : [],
    );
    await remember("succeeded", null);
    return { outcome: "written", result: { written: records.length, skipped, records } };
  } catch (error) {
    if (!(error instanceof SiteDataError)) throw error;
    await remember("failed", error.message);
    if (error.code === "forbidden" || error.code === "not_found")
      return { outcome: "rejected", status: 403, reason: error.message };
    if (error.code === "rate_limited" || error.code === "quota_exceeded")
      return { outcome: "rejected", status: 429, reason: error.message };
    return { outcome: "invalid", reason: error.message };
  }
}
