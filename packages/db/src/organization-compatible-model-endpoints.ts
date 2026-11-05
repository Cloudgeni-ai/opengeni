import { createHash } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { type Database, withRlsContext } from "./database";
import { decryptEnvironmentValue } from "./environment-crypto";
import {
  OrganizationModelProviderConflictError,
  OrganizationModelProviderLimitError,
  withOrganizationProviderAdministrator,
} from "./organization-model-providers";
import * as schema from "./schema";

// An organization's own OpenAI-compatible endpoints: organization model
// accounts like its OpenAI or Azure OpenAI key, stored in the same tables
// under the same administrator check and workspace access policy. An
// organization can connect several, so each endpoint is its own connection
// row (kind `openai_compatible`) and its models carry that row's id.

const KIND = "openai_compatible" as const;
/** Active endpoints one organization can connect at once. */
export const ORGANIZATION_COMPATIBLE_ENDPOINT_LIMIT = 50;
const ENDPOINT_HISTORY_LIMIT = 500;
const MODEL_LIMIT = 100;
const MODEL_HISTORY_LIMIT = 1000;

export type OrganizationCompatibleEndpointApi = "chat" | "responses";

export type OrganizationCompatibleEndpoint = {
  id: string;
  status: "active" | "revoked";
  version: number;
  /** The non-secret public HTTPS base URL, usually ending in /v1. */
  baseUrl: string;
  api: OrganizationCompatibleEndpointApi;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganizationCompatibleEndpointModel = {
  id: string;
  connectionId: string;
  upstreamModelId: string;
  label: string | null;
  version: number;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** An active endpoint a workspace can use, with its active models. */
export type OrganizationCompatibleEndpointForWorkspace = {
  id: string;
  baseUrl: string;
  api: OrganizationCompatibleEndpointApi;
  label: string | null;
  models: OrganizationCompatibleEndpointModel[];
  /** Present only when credentials were requested and an encryption key is configured. */
  credentialEncrypted?: string;
};

type ConnectionRow = typeof schema.organizationModelProviderConnections.$inferSelect;
type ModelRow = typeof schema.organizationModelProviderCustomModels.$inferSelect;
const connections = schema.organizationModelProviderConnections;
const models = schema.organizationModelProviderCustomModels;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapEndpoint(row: ConnectionRow): OrganizationCompatibleEndpoint {
  if (row.providerKind !== KIND || !row.endpoint || !row.compatibleApi)
    throw new Error("not an OpenAI-compatible endpoint connection");
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    baseUrl: row.endpoint,
    api: row.compatibleApi,
    label: row.label ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapModel(row: ModelRow): OrganizationCompatibleEndpointModel {
  if (!row.connectionId) throw new Error("not an OpenAI-compatible endpoint model");
  return {
    id: row.id,
    connectionId: row.connectionId,
    upstreamModelId: row.upstreamModelId,
    label: row.label,
    version: row.version,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function lockEndpoints(scopedDb: Database, organizationId: string): Promise<void> {
  await scopedDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider:${organizationId}:${KIND}`}, 0))`,
  );
}

async function lockModels(scopedDb: Database, organizationId: string): Promise<void> {
  await scopedDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider-models:${organizationId}:${KIND}`}, 0))`,
  );
}

async function endpointRow(
  scopedDb: Database,
  organizationId: string,
  connectionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ConnectionRow | null> {
  const query = scopedDb
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.accountId, organizationId),
        eq(connections.providerKind, KIND),
        eq(connections.id, connectionId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

/** The organization's active endpoints with their active models, for its administrators. */
export async function listOrganizationCompatibleEndpoints(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<
  { endpoint: OrganizationCompatibleEndpoint; models: OrganizationCompatibleEndpointModel[] }[]
> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.accountId, input.organizationId),
          eq(connections.providerKind, KIND),
          eq(connections.status, "active"),
        ),
      )
      .orderBy(connections.createdAt, connections.id);
    const modelRows = rows.length
      ? await scopedDb
          .select()
          .from(models)
          .where(
            and(
              eq(models.accountId, input.organizationId),
              eq(models.providerKind, KIND),
              inArray(
                models.connectionId,
                rows.map((row) => row.id),
              ),
              isNull(models.retiredAt),
            ),
          )
          .orderBy(models.createdAt, models.id)
      : [];
    return rows.map((row) => ({
      endpoint: mapEndpoint(row),
      models: modelRows.filter((model) => model.connectionId === row.id).map(mapModel),
    }));
  });
}

/** One endpoint of the organization, active or revoked, for its administrators. */
export async function getOrganizationCompatibleEndpoint(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; connectionId: string },
): Promise<OrganizationCompatibleEndpoint | null> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const row = await endpointRow(scopedDb, input.organizationId, input.connectionId);
    return row ? mapEndpoint(row) : null;
  });
}

/**
 * Connect a new endpoint with its first model, which the caller has already
 * checked against the endpoint with this key. A replay of the same operation
 * returns what it created; any other request under its id conflicts.
 */
export async function createOrganizationCompatibleEndpoint(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    credentialEncrypted: string;
    credentialDigest: string;
    baseUrl: string;
    api: OrganizationCompatibleEndpointApi;
    label?: string | null;
    upstreamModelId: string;
    operationId: string;
  },
): Promise<{
  endpoint: OrganizationCompatibleEndpoint;
  model: OrganizationCompatibleEndpointModel;
}> {
  const label = input.label?.trim() || null;
  const requestHash = digest({
    operation: "create",
    credentialDigest: input.credentialDigest,
    baseUrl: input.baseUrl,
    api: input.api,
    label,
    upstreamModelId: input.upstreamModelId,
  });
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await lockEndpoints(scopedDb, input.organizationId);
    await lockModels(scopedDb, input.organizationId);
    const [replay] = await scopedDb
      .select()
      .from(models)
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.createOperationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      const endpoint = replay.connectionId
        ? await endpointRow(scopedDb, input.organizationId, replay.connectionId)
        : null;
      // The endpoint may have changed since (a new key, or revoked); the
      // receipt is the model row this operation created.
      if (replay.createRequestHash !== requestHash || !endpoint)
        throw new OrganizationModelProviderConflictError();
      return { endpoint: mapEndpoint(endpoint), model: mapModel(replay) };
    }
    const [{ active = 0, total = 0 } = {}] = await scopedDb
      .select({
        active: count(sql`case when ${connections.status} = 'active' then 1 end`),
        total: count(),
      })
      .from(connections)
      .where(
        and(eq(connections.accountId, input.organizationId), eq(connections.providerKind, KIND)),
      );
    if (
      Number(active) >= ORGANIZATION_COMPATIBLE_ENDPOINT_LIMIT ||
      Number(total) >= ENDPOINT_HISTORY_LIMIT
    )
      throw new OrganizationModelProviderLimitError();
    const [row] = await scopedDb
      .insert(connections)
      .values({
        accountId: input.organizationId,
        providerKind: KIND,
        credentialEncrypted: input.credentialEncrypted,
        endpoint: input.baseUrl,
        compatibleApi: input.api,
        label,
        operationId: input.operationId,
        requestHash,
        updatedBySubjectId: input.actorSubjectId,
      })
      .returning();
    if (!row) throw new Error("organization compatible endpoint create returned no row");
    const [model] = await scopedDb
      .insert(models)
      .values({
        accountId: input.organizationId,
        providerKind: KIND,
        connectionId: row.id,
        upstreamModelId: input.upstreamModelId,
        label: null,
        createOperationId: input.operationId,
        createRequestHash: requestHash,
        createdBySubjectId: input.actorSubjectId,
      })
      .returning();
    if (!model) throw new Error("organization compatible endpoint model create returned no row");
    return { endpoint: mapEndpoint(row), model: mapModel(model) };
  });
}

/**
 * Replace an active endpoint's key (checked by the caller) or revoke the
 * endpoint. The connection row keeps its latest operation, so repeating that
 * operation returns the current endpoint; an older or changed one conflicts.
 */
async function changeEndpoint(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    connectionId: string;
    operationId: string;
    expectedVersion: number;
  },
  change:
    | { operation: "replace_key"; credentialEncrypted: string; credentialDigest: string }
    | { operation: "revoke" },
): Promise<OrganizationCompatibleEndpoint> {
  const requestHash = digest({
    operation: change.operation,
    connectionId: input.connectionId,
    expectedVersion: input.expectedVersion,
    ...(change.operation === "replace_key" ? { credentialDigest: change.credentialDigest } : {}),
  });
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await lockEndpoints(scopedDb, input.organizationId);
    const [sameOperation] = await scopedDb
      .select({ id: connections.id, requestHash: connections.requestHash })
      .from(connections)
      .where(
        and(
          eq(connections.accountId, input.organizationId),
          eq(connections.providerKind, KIND),
          eq(connections.operationId, input.operationId),
        ),
      )
      .limit(1);
    const existing = await endpointRow(scopedDb, input.organizationId, input.connectionId, {
      forUpdate: true,
    });
    if (!existing) throw new OrganizationModelProviderConflictError();
    if (sameOperation) {
      if (sameOperation.id !== existing.id || sameOperation.requestHash !== requestHash)
        throw new OrganizationModelProviderConflictError();
      return mapEndpoint(existing);
    }
    if (existing.version !== input.expectedVersion || existing.status !== "active")
      throw new OrganizationModelProviderConflictError();
    const [row] = await scopedDb
      .update(connections)
      .set({
        ...(change.operation === "replace_key"
          ? { credentialEncrypted: change.credentialEncrypted }
          : { status: "revoked" as const, credentialEncrypted: "" }),
        version: existing.version + 1,
        operationId: input.operationId,
        requestHash,
        updatedBySubjectId: input.actorSubjectId,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, existing.id))
      .returning();
    if (!row) throw new Error("organization compatible endpoint update returned no row");
    return mapEndpoint(row);
  });
}

export async function replaceOrganizationCompatibleEndpointKey(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    connectionId: string;
    credentialEncrypted: string;
    credentialDigest: string;
    operationId: string;
    expectedVersion: number;
  },
): Promise<OrganizationCompatibleEndpoint> {
  return await changeEndpoint(db, input, {
    operation: "replace_key",
    credentialEncrypted: input.credentialEncrypted,
    credentialDigest: input.credentialDigest,
  });
}

/** Disconnect an endpoint: its key is erased and its models leave every workspace. */
export async function revokeOrganizationCompatibleEndpoint(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    connectionId: string;
    operationId: string;
    expectedVersion: number;
  },
): Promise<OrganizationCompatibleEndpoint> {
  return await changeEndpoint(db, input, { operation: "revoke" });
}

/**
 * The administrator's view of an active endpoint and its decrypted key, for
 * checking a model or a replacement key before it is saved. Never returned
 * to a client. Null without an active endpoint or an encryption key.
 */
export async function loadOrganizationCompatibleEndpointCredentialForAdministrator(
  db: Database,
  settings: Settings,
  input: { organizationId: string; actorSubjectId: string; connectionId: string },
): Promise<{ endpoint: OrganizationCompatibleEndpoint; apiKey: string } | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) return null;
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const row = await endpointRow(scopedDb, input.organizationId, input.connectionId);
    if (!row || row.status !== "active") return null;
    return {
      endpoint: mapEndpoint(row),
      apiKey: decryptEnvironmentValue(key, row.credentialEncrypted),
    };
  });
}

export async function listOrganizationCompatibleEndpointModels(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; connectionId: string },
): Promise<OrganizationCompatibleEndpointModel[]> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(models)
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.connectionId, input.connectionId),
          isNull(models.retiredAt),
        ),
      )
      .orderBy(models.createdAt, models.id);
    return rows.map(mapModel);
  });
}

/** Add a model (already checked against the endpoint) to an active endpoint. */
export async function createOrganizationCompatibleEndpointModel(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    connectionId: string;
    upstreamModelId: string;
    label?: string;
    operationId: string;
  },
): Promise<OrganizationCompatibleEndpointModel> {
  const requestHash = digest({
    connectionId: input.connectionId,
    upstreamModelId: input.upstreamModelId,
    label: input.label ?? null,
  });
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await lockModels(scopedDb, input.organizationId);
    const [replay] = await scopedDb
      .select()
      .from(models)
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.createOperationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.createRequestHash !== requestHash)
        throw new OrganizationModelProviderConflictError();
      return mapModel(replay);
    }
    const endpoint = await endpointRow(scopedDb, input.organizationId, input.connectionId);
    if (!endpoint || endpoint.status !== "active")
      throw new OrganizationModelProviderConflictError();
    const [{ active = 0, total = 0 } = {}] = await scopedDb
      .select({
        active: count(sql`case when ${models.retiredAt} is null then 1 end`),
        total: count(),
      })
      .from(models)
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.connectionId, input.connectionId),
        ),
      );
    if (Number(active) >= MODEL_LIMIT || Number(total) >= MODEL_HISTORY_LIMIT)
      throw new OrganizationModelProviderLimitError();
    const [duplicate] = await scopedDb
      .select({ id: models.id })
      .from(models)
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.connectionId, input.connectionId),
          eq(models.upstreamModelId, input.upstreamModelId),
          isNull(models.retiredAt),
        ),
      )
      .limit(1);
    if (duplicate) throw new OrganizationModelProviderConflictError();
    const [row] = await scopedDb
      .insert(models)
      .values({
        accountId: input.organizationId,
        providerKind: KIND,
        connectionId: input.connectionId,
        upstreamModelId: input.upstreamModelId,
        label: input.label ?? null,
        createOperationId: input.operationId,
        createRequestHash: requestHash,
        createdBySubjectId: input.actorSubjectId,
      })
      .returning();
    if (!row) throw new Error("organization compatible endpoint model create returned no row");
    return mapModel(row);
  });
}

export async function retireOrganizationCompatibleEndpointModel(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    connectionId: string;
    customModelId: string;
    expectedVersion: number;
    operationId: string;
  },
): Promise<OrganizationCompatibleEndpointModel> {
  const requestHash = digest({
    connectionId: input.connectionId,
    customModelId: input.customModelId,
    expectedVersion: input.expectedVersion,
  });
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await lockModels(scopedDb, input.organizationId);
    const [replay] = await scopedDb
      .select()
      .from(models)
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.deleteOperationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.deleteRequestHash !== requestHash)
        throw new OrganizationModelProviderConflictError();
      return mapModel(replay);
    }
    const [row] = await scopedDb
      .update(models)
      .set({
        retiredAt: new Date(),
        deleteOperationId: input.operationId,
        deleteRequestHash: requestHash,
        version: input.expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(models.accountId, input.organizationId),
          eq(models.providerKind, KIND),
          eq(models.connectionId, input.connectionId),
          eq(models.id, input.customModelId),
          eq(models.version, input.expectedVersion),
          isNull(models.retiredAt),
        ),
      )
      .returning();
    if (!row) throw new OrganizationModelProviderConflictError();
    return mapModel(row);
  });
}

/**
 * The active endpoints a workspace can use (the connection's access policy
 * decides, as for every organization account) with their active models.
 * Internal reader: the caller owns the workspace's tenant scope. Encrypted
 * keys are read only on request.
 */
export async function listOrganizationCompatibleEndpointsInScope(
  scopedDb: Database,
  input: { accountId: string; includeCredentials?: boolean },
): Promise<OrganizationCompatibleEndpointForWorkspace[]> {
  const rows = await scopedDb
    .select({
      id: connections.id,
      endpoint: connections.endpoint,
      compatibleApi: connections.compatibleApi,
      label: connections.label,
      credentialEncrypted: connections.credentialEncrypted,
    })
    .from(connections)
    .where(
      and(
        eq(connections.accountId, input.accountId),
        eq(connections.providerKind, KIND),
        eq(connections.status, "active"),
      ),
    )
    .orderBy(connections.createdAt, connections.id);
  if (rows.length === 0) return [];
  const modelRows = await scopedDb
    .select()
    .from(models)
    .where(
      and(
        eq(models.accountId, input.accountId),
        eq(models.providerKind, KIND),
        inArray(
          models.connectionId,
          rows.map((row) => row.id),
        ),
        isNull(models.retiredAt),
      ),
    )
    .orderBy(models.createdAt, models.id);
  return rows.flatMap((row) =>
    row.endpoint && row.compatibleApi
      ? [
          {
            id: row.id,
            baseUrl: row.endpoint,
            api: row.compatibleApi,
            label: row.label ?? null,
            models: modelRows.filter((model) => model.connectionId === row.id).map(mapModel),
            ...(input.includeCredentials ? { credentialEncrypted: row.credentialEncrypted } : {}),
          },
        ]
      : [],
  );
}

/** The organization endpoints one workspace can use; secret-free unless credentials are asked for. */
export async function listOrganizationCompatibleEndpointsForWorkspace(
  db: Database,
  input: { accountId: string; workspaceId: string; includeCredentials?: boolean },
): Promise<OrganizationCompatibleEndpointForWorkspace[]> {
  return await withRlsContext(db, input, (scopedDb) =>
    listOrganizationCompatibleEndpointsInScope(scopedDb, {
      accountId: input.accountId,
      includeCredentials: input.includeCredentials === true,
    }),
  );
}

/**
 * The endpoints with their decrypted keys, for the execution overlay. An
 * endpoint keeps no key when none was read or no encryption key is
 * configured, so its requests fail closed.
 */
export function decryptOrganizationCompatibleEndpointKeys(
  settings: Settings,
  endpoints: readonly OrganizationCompatibleEndpointForWorkspace[],
): (Omit<OrganizationCompatibleEndpointForWorkspace, "credentialEncrypted"> & {
  apiKey?: string;
})[] {
  const key = environmentsEncryptionKeyBytes(settings);
  return endpoints.map(({ credentialEncrypted, ...endpoint }) =>
    key && credentialEncrypted
      ? { ...endpoint, apiKey: decryptEnvironmentValue(key, credentialEncrypted) }
      : endpoint,
  );
}

/**
 * The decrypted key of one active endpoint a workspace can use, read under
 * the workspace's scope like the execution catalog. Null when the endpoint is
 * gone, out of the workspace's reach or no encryption key is configured.
 */
export async function loadOrganizationCompatibleEndpointApiKey(
  db: Database,
  settings: Settings,
  input: { accountId: string; workspaceId: string; connectionId: string },
): Promise<string | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) return null;
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ credentialEncrypted: connections.credentialEncrypted })
      .from(connections)
      .where(
        and(
          eq(connections.accountId, input.accountId),
          eq(connections.providerKind, KIND),
          eq(connections.id, input.connectionId),
          eq(connections.status, "active"),
        ),
      )
      .limit(1);
    return row ? decryptEnvironmentValue(key, row.credentialEncrypted) : null;
  });
}
