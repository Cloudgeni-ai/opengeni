import { createHash, randomUUID } from "node:crypto";
import {
  AuthRun,
  AuthRunListResponse,
  AuthRunMutationResponse,
  BrowserExternalAuthResult,
  CreateInteractionInterventionRequest,
  CreateNetworkRouteRequest,
  CreateSiteAuthConnectionRequest,
  ExternalAuthInteractiveRequest,
  ExternalAuthRunRequest,
  ExternalAuthRunResponse,
  InteractionIntervention,
  InteractionInterventionListResponse,
  InteractionInterventionMutationResponse,
  NetworkRoute,
  NetworkRouteConfiguration,
  NetworkRouteConsistency,
  NetworkRouteListResponse,
  NetworkRouteMutationResponse,
  ProtectedAuthFillRequest,
  ProtectedAuthFillResponse,
  ReportAuthRunRequest,
  RequestHumanInteractionToolInput,
  SiteAuthAuthority,
  ResolveInteractionInterventionRequest,
  SiteAuthConnection,
  SiteAuthConnectionListResponse,
  SiteAuthConnectionMutationResponse,
  StartAuthRunRequest,
  UpdateNetworkRouteRequest,
  UpdateSiteAuthConnectionRequest,
  VerifyAuthRunRequest,
  type AuthRun as AuthRunValue,
  type AuthRunListResponse as AuthRunListResponseValue,
  type AuthRunMutationResponse as AuthRunMutationResponseValue,
  type CreateInteractionInterventionRequest as CreateInteractionInterventionRequestValue,
  type CreateNetworkRouteRequest as CreateNetworkRouteRequestValue,
  type CreateSiteAuthConnectionRequest as CreateSiteAuthConnectionRequestValue,
  type BrowserExternalAuthResult as BrowserExternalAuthResultValue,
  type ExternalAuthInteractiveRequest as ExternalAuthInteractiveRequestValue,
  type ExternalAuthRunRequest as ExternalAuthRunRequestValue,
  type ExternalAuthRunResponse as ExternalAuthRunResponseValue,
  type InteractionCredentialAuthorityRef,
  type InteractionIntervention as InteractionInterventionValue,
  type InteractionInterventionListResponse as InteractionInterventionListResponseValue,
  type InteractionInterventionMutationResponse as InteractionInterventionMutationResponseValue,
  type NetworkRoute as NetworkRouteValue,
  type NetworkRouteConfiguration as NetworkRouteConfigurationValue,
  type NetworkRouteListResponse as NetworkRouteListResponseValue,
  type NetworkRouteMutationResponse as NetworkRouteMutationResponseValue,
  type ProtectedAuthFillRequest as ProtectedAuthFillRequestValue,
  type ProtectedAuthFillResponse as ProtectedAuthFillResponseValue,
  type ReportAuthRunRequest as ReportAuthRunRequestValue,
  type ResolveInteractionInterventionRequest as ResolveInteractionInterventionRequestValue,
  type RequestHumanInteractionToolInput as RequestHumanInteractionToolInputValue,
  type SessionEvent,
  type SiteAuthAuthority as SiteAuthAuthorityValue,
  type SiteAuthConnection as SiteAuthConnectionValue,
  type SiteAuthConnectionListResponse as SiteAuthConnectionListResponseValue,
  type SiteAuthConnectionMutationResponse as SiteAuthConnectionMutationResponseValue,
  type StartAuthRunRequest as StartAuthRunRequestValue,
  type UpdateNetworkRouteRequest as UpdateNetworkRouteRequestValue,
  type UpdateSiteAuthConnectionRequest as UpdateSiteAuthConnectionRequestValue,
  type VerifyAuthRunRequest as VerifyAuthRunRequestValue,
} from "@opengeni/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import { safeDatabaseErrorFacts } from "./persistence-errors";
import * as schema from "./schema";

type NetworkRouteRow = typeof schema.networkRoutes.$inferSelect;
type SiteAuthConnectionRow = typeof schema.siteAuthConnections.$inferSelect;
type AuthRunRow = typeof schema.authRuns.$inferSelect;
type InterventionRow = typeof schema.interactionInterventions.$inferSelect;
type ResourceOperationRow = typeof schema.interactionResourceOperations.$inferSelect;

type InteractionMutationScope = {
  accountId: string;
  workspaceId: string;
  actorSubjectId: string;
};

type ResourceKind = ResourceOperationRow["resourceKind"];
type ResourceOperationKind = ResourceOperationRow["kind"];

const CONSISTENT_READ = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

export class InteractionResourceNotFoundError extends Error {
  readonly name = "InteractionResourceNotFoundError";
}

export class InteractionResourceConflictError extends Error {
  readonly name = "InteractionResourceConflictError";
}

export class InteractionResourceStateError extends Error {
  readonly name = "InteractionResourceStateError";
}

function iso(value: Date): string {
  return value.toISOString();
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function operationDigest(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

function postgresConstraint(error: unknown): string | null {
  return safeDatabaseErrorFacts(error).constraint ?? null;
}

function routeFromRow(row: NetworkRouteRow): NetworkRouteValue {
  return NetworkRoute.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    configuration: row.configuration,
    consistency: row.consistency,
    version: row.version,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function siteAuthConnectionFromRow(row: SiteAuthConnectionRow): SiteAuthConnectionValue {
  return SiteAuthConnection.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    accountLabel: row.accountLabel,
    status: row.status,
    origins: row.origins,
    loginUrl: row.loginUrl,
    verificationUrlPrefixes: row.verificationUrlPrefixes,
    authorities: row.authorities,
    methods: row.methods,
    preferredIdentityId: row.preferredIdentityId,
    preferredPlacement: row.preferredPlacement,
    preferredNetworkRouteId: row.preferredNetworkRouteId,
    healthPolicy: row.healthPolicy,
    verificationState: row.verificationState,
    lastVerifiedAt: row.lastVerifiedAt ? iso(row.lastVerifiedAt) : null,
    lastVerifiedUrl: row.lastVerifiedUrl,
    lastCheckedAt: row.lastCheckedAt ? iso(row.lastCheckedAt) : null,
    nextCheckAt: row.nextCheckAt ? iso(row.nextCheckAt) : null,
    repairCode: row.repairCode,
    version: row.version,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function nextMaintainedAuthCheck(
  status: SiteAuthConnectionRow["status"],
  policy: SiteAuthConnectionRow["healthPolicy"],
  lastCheckedAt: Date | null,
): Date | null {
  if (status !== "active" || policy.mode !== "maintained" || policy.intervalSeconds === null) {
    return null;
  }
  return lastCheckedAt
    ? new Date(lastCheckedAt.getTime() + policy.intervalSeconds * 1_000)
    : new Date();
}

async function lockOperation(db: Database, operationId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`interaction-resource:${operationId}`}, 0))`,
  );
}

async function loadOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<ResourceOperationRow | null> {
  const [row] = await db
    .select()
    .from(schema.interactionResourceOperations)
    .where(
      and(
        eq(schema.interactionResourceOperations.workspaceId, workspaceId),
        eq(schema.interactionResourceOperations.operationId, operationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function assertOperationIdentity(
  operation: ResourceOperationRow,
  expected: {
    resourceKind: ResourceKind;
    resourceId?: string;
    kind: ResourceOperationKind;
    requestDigest: string;
    actorSubjectId: string;
  },
): void {
  if (
    operation.resourceKind !== expected.resourceKind ||
    (expected.resourceId !== undefined && operation.resourceId !== expected.resourceId) ||
    operation.kind !== expected.kind ||
    operation.requestDigest !== expected.requestDigest ||
    operation.actorSubjectId !== expected.actorSubjectId
  ) {
    throw new InteractionResourceConflictError(
      "Operation id is already bound to another interaction request",
    );
  }
}

function assertOperation(
  operation: ResourceOperationRow,
  expected: {
    resourceKind: ResourceKind;
    resourceId?: string;
    kind: ResourceOperationKind;
    requestDigest: string;
    actorSubjectId: string;
  },
): void {
  assertOperationIdentity(operation, expected);
  if (operation.state !== "completed" || !operation.result || !operation.resultVersion) {
    throw new InteractionResourceStateError("Interaction operation is not complete");
  }
}

async function insertCompletedOperation(
  db: Database,
  input: {
    operationId: string;
    accountId: string;
    workspaceId: string;
    resourceKind: ResourceKind;
    resourceId: string;
    kind: ResourceOperationKind;
    requestDigest: string;
    resultVersion: number;
    result: Record<string, unknown>;
    actorSubjectId: string;
  },
): Promise<void> {
  await db.insert(schema.interactionResourceOperations).values({
    ...input,
    state: "completed",
    settledAt: sql`now()`,
  });
}

async function assertWorkspaceAccount(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<void> {
  const [workspace] = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.accountId, accountId)))
    .limit(1);
  if (!workspace) throw new InteractionResourceNotFoundError("Workspace not found");
}

function credentialRefsFromRoute(
  configuration: NetworkRouteConfigurationValue,
): InteractionCredentialAuthorityRef[] {
  return "credential" in configuration && configuration.credential
    ? [configuration.credential]
    : [];
}

function credentialRefsFromAuthorities(
  authorities: readonly SiteAuthAuthorityValue[],
): InteractionCredentialAuthorityRef[] {
  return authorities.flatMap((authority) =>
    "credential" in authority && authority.credential ? [authority.credential] : [],
  );
}

function credentialRefKey(reference: InteractionCredentialAuthorityRef): string {
  return `${reference.connectionId}\u0000${reference.connectionSubjectId ?? ""}\u0000${reference.providerDomain}`;
}

function introducedCredentialRefs(
  current: readonly InteractionCredentialAuthorityRef[],
  candidate: readonly InteractionCredentialAuthorityRef[],
): InteractionCredentialAuthorityRef[] {
  const trusted = new Set(current.map(credentialRefKey));
  return candidate.filter((reference) => !trusted.has(credentialRefKey(reference)));
}

async function assertCredentialAuthorities(
  db: Database,
  workspaceId: string,
  refs: readonly InteractionCredentialAuthorityRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const ids = [...new Set(refs.map((reference) => reference.connectionId))];
  const rows = await db
    .select({
      id: schema.connections.id,
      subjectId: schema.connections.subjectId,
      providerDomain: schema.connections.providerDomain,
      status: schema.connections.status,
    })
    .from(schema.connections)
    .where(
      and(eq(schema.connections.workspaceId, workspaceId), inArray(schema.connections.id, ids)),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const reference of refs) {
    const row = byId.get(reference.connectionId);
    if (
      !row ||
      row.subjectId !== reference.connectionSubjectId ||
      row.providerDomain !== reference.providerDomain
    ) {
      throw new InteractionResourceNotFoundError("Credential authority not found");
    }
    if (row.status !== "active") {
      throw new InteractionResourceStateError("Credential authority is not active");
    }
  }
}

async function assertActiveBrowserIdentity(
  db: Database,
  workspaceId: string,
  identityId: string | null,
): Promise<void> {
  if (!identityId) return;
  const [identity] = await db
    .select({ status: schema.browserIdentities.status })
    .from(schema.browserIdentities)
    .where(
      and(
        eq(schema.browserIdentities.workspaceId, workspaceId),
        eq(schema.browserIdentities.id, identityId),
      ),
    )
    .limit(1);
  if (!identity) throw new InteractionResourceNotFoundError("Preferred browser identity not found");
  if (identity.status !== "active") {
    throw new InteractionResourceStateError("Preferred browser identity is archived");
  }
}

async function assertActiveNetworkRoute(
  db: Database,
  workspaceId: string,
  routeId: string | null,
): Promise<void> {
  if (!routeId) return;
  const [route] = await db
    .select({ status: schema.networkRoutes.status })
    .from(schema.networkRoutes)
    .where(
      and(eq(schema.networkRoutes.workspaceId, workspaceId), eq(schema.networkRoutes.id, routeId)),
    )
    .limit(1);
  if (!route) throw new InteractionResourceNotFoundError("Preferred network route not found");
  if (route.status !== "active") {
    throw new InteractionResourceStateError("Preferred network route is archived");
  }
}

export async function listNetworkRoutes(
  db: Database,
  input: { accountId: string; workspaceId: string; includeArchived?: boolean },
): Promise<NetworkRouteListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const predicate = input.includeArchived
        ? eq(schema.networkRoutes.workspaceId, input.workspaceId)
        : and(
            eq(schema.networkRoutes.workspaceId, input.workspaceId),
            eq(schema.networkRoutes.status, "active"),
          );
      const routes = await scopedDb
        .select()
        .from(schema.networkRoutes)
        .where(predicate)
        .orderBy(asc(schema.networkRoutes.name), asc(schema.networkRoutes.id));
      return NetworkRouteListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        routes: routes.map(routeFromRow),
      });
    },
    CONSISTENT_READ,
  );
}

export async function getNetworkRoute(
  db: Database,
  input: { accountId: string; workspaceId: string; routeId: string },
): Promise<NetworkRouteValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.networkRoutes)
        .where(
          and(
            eq(schema.networkRoutes.workspaceId, input.workspaceId),
            eq(schema.networkRoutes.id, input.routeId),
          ),
        )
        .limit(1);
      if (!row) throw new InteractionResourceNotFoundError("Network route not found");
      return routeFromRow(row);
    },
    CONSISTENT_READ,
  );
}

export async function createNetworkRoute(
  db: Database,
  input: InteractionMutationScope & CreateNetworkRouteRequestValue,
): Promise<NetworkRouteMutationResponseValue> {
  const request = CreateNetworkRouteRequest.parse({
    operationId: input.operationId,
    name: input.name,
    configuration: input.configuration,
    consistency: input.consistency,
  });
  const digest = operationDigest({
    version: 1,
    name: request.name,
    configuration: request.configuration,
    consistency: request.consistency,
    actorSubjectId: input.actorSubjectId,
  });
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await lockOperation(scopedDb, request.operationId);
      const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (existing) {
        assertOperation(existing, {
          resourceKind: "network_route",
          kind: "create",
          requestDigest: digest,
          actorSubjectId: input.actorSubjectId,
        });
        const response = NetworkRouteMutationResponse.parse(existing.result);
        return { ...response, replayed: true };
      }
      await assertCredentialAuthorities(
        scopedDb,
        input.workspaceId,
        credentialRefsFromRoute(request.configuration),
      );
      const id = randomUUID();
      const [row] = await scopedDb
        .insert(schema.networkRoutes)
        .values({
          id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: request.name,
          configuration: request.configuration,
          consistency: request.consistency,
          createOperationId: request.operationId,
          createdBySubjectId: input.actorSubjectId,
          updatedBySubjectId: input.actorSubjectId,
        })
        .returning();
      if (!row) throw new Error("Network route insert returned no row");
      const response = NetworkRouteMutationResponse.parse({
        route: routeFromRow(row),
        operationId: request.operationId,
        replayed: false,
      });
      await insertCompletedOperation(scopedDb, {
        operationId: request.operationId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        resourceKind: "network_route",
        resourceId: id,
        kind: "create",
        requestDigest: digest,
        resultVersion: row.version,
        result: response,
        actorSubjectId: input.actorSubjectId,
      });
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (postgresConstraint(error) === "network_routes_workspace_active_name_uq") {
      throw new InteractionResourceConflictError("An active network route already uses this name");
    }
    throw error;
  }
}

export async function updateNetworkRoute(
  db: Database,
  input: InteractionMutationScope & {
    routeId: string;
  } & UpdateNetworkRouteRequestValue,
): Promise<NetworkRouteMutationResponseValue> {
  const request = UpdateNetworkRouteRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
    ...(input.consistency !== undefined ? { consistency: input.consistency } : {}),
  });
  const { operationId: _operationId, ...digestRequest } = request;
  const digest = operationDigest({
    version: 1,
    routeId: input.routeId,
    request: digestRequest,
    actorSubjectId: input.actorSubjectId,
  });
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await lockOperation(scopedDb, request.operationId);
      const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (existing) {
        assertOperation(existing, {
          resourceKind: "network_route",
          resourceId: input.routeId,
          kind: "update",
          requestDigest: digest,
          actorSubjectId: input.actorSubjectId,
        });
        const response = NetworkRouteMutationResponse.parse(existing.result);
        return { ...response, replayed: true };
      }
      const [current] = await scopedDb
        .select()
        .from(schema.networkRoutes)
        .where(
          and(
            eq(schema.networkRoutes.workspaceId, input.workspaceId),
            eq(schema.networkRoutes.id, input.routeId),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) throw new InteractionResourceNotFoundError("Network route not found");
      if (current.version !== request.expectedVersion) {
        throw new InteractionResourceConflictError("Network route changed before this update");
      }
      const configuration = NetworkRouteConfiguration.parse(
        request.configuration ?? current.configuration,
      );
      const consistency = NetworkRouteConsistency.parse(request.consistency ?? current.consistency);
      await assertCredentialAuthorities(
        scopedDb,
        input.workspaceId,
        introducedCredentialRefs(
          credentialRefsFromRoute(NetworkRouteConfiguration.parse(current.configuration)),
          credentialRefsFromRoute(configuration),
        ),
      );
      const [row] = await scopedDb
        .update(schema.networkRoutes)
        .set({
          name: request.name ?? current.name,
          status: request.status ?? current.status,
          configuration,
          consistency,
          version: current.version + 1,
          updatedBySubjectId: input.actorSubjectId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.networkRoutes.workspaceId, input.workspaceId),
            eq(schema.networkRoutes.id, input.routeId),
            eq(schema.networkRoutes.version, request.expectedVersion),
          ),
        )
        .returning();
      if (!row) throw new InteractionResourceConflictError("Network route update lost its fence");
      const response = NetworkRouteMutationResponse.parse({
        route: routeFromRow(row),
        operationId: request.operationId,
        replayed: false,
      });
      await insertCompletedOperation(scopedDb, {
        operationId: request.operationId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        resourceKind: "network_route",
        resourceId: input.routeId,
        kind: "update",
        requestDigest: digest,
        resultVersion: row.version,
        result: response,
        actorSubjectId: input.actorSubjectId,
      });
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (postgresConstraint(error) === "network_routes_workspace_active_name_uq") {
      throw new InteractionResourceConflictError("An active network route already uses this name");
    }
    throw error;
  }
}

export async function listSiteAuthConnections(
  db: Database,
  input: { accountId: string; workspaceId: string; includeArchived?: boolean },
): Promise<SiteAuthConnectionListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const predicate = input.includeArchived
        ? eq(schema.siteAuthConnections.workspaceId, input.workspaceId)
        : and(
            eq(schema.siteAuthConnections.workspaceId, input.workspaceId),
            eq(schema.siteAuthConnections.status, "active"),
          );
      const connections = await scopedDb
        .select()
        .from(schema.siteAuthConnections)
        .where(predicate)
        .orderBy(asc(schema.siteAuthConnections.name), asc(schema.siteAuthConnections.id));
      return SiteAuthConnectionListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        connections: connections.map(siteAuthConnectionFromRow),
      });
    },
    CONSISTENT_READ,
  );
}

export async function getSiteAuthConnection(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    siteAuthConnectionId: string;
  },
): Promise<SiteAuthConnectionValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.siteAuthConnections)
        .where(
          and(
            eq(schema.siteAuthConnections.workspaceId, input.workspaceId),
            eq(schema.siteAuthConnections.id, input.siteAuthConnectionId),
          ),
        )
        .limit(1);
      if (!row) throw new InteractionResourceNotFoundError("Site auth connection not found");
      return siteAuthConnectionFromRow(row);
    },
    CONSISTENT_READ,
  );
}

async function validateSiteAuthReferences(
  db: Database,
  workspaceId: string,
  connection: Pick<
    SiteAuthConnectionValue,
    "authorities" | "preferredIdentityId" | "preferredNetworkRouteId"
  >,
): Promise<void> {
  await assertCredentialAuthorities(
    db,
    workspaceId,
    credentialRefsFromAuthorities(connection.authorities),
  );
  await assertActiveBrowserIdentity(db, workspaceId, connection.preferredIdentityId);
  await assertActiveNetworkRoute(db, workspaceId, connection.preferredNetworkRouteId);
}

async function validateSiteAuthUpdateReferences(
  db: Database,
  workspaceId: string,
  current: SiteAuthConnectionValue,
  candidate: SiteAuthConnectionValue,
): Promise<void> {
  await assertCredentialAuthorities(
    db,
    workspaceId,
    introducedCredentialRefs(
      credentialRefsFromAuthorities(current.authorities),
      credentialRefsFromAuthorities(candidate.authorities),
    ),
  );
  if (candidate.preferredIdentityId !== current.preferredIdentityId) {
    await assertActiveBrowserIdentity(db, workspaceId, candidate.preferredIdentityId);
  }
  if (candidate.preferredNetworkRouteId !== current.preferredNetworkRouteId) {
    await assertActiveNetworkRoute(db, workspaceId, candidate.preferredNetworkRouteId);
  }
}

export async function createSiteAuthConnection(
  db: Database,
  input: InteractionMutationScope & CreateSiteAuthConnectionRequestValue,
): Promise<SiteAuthConnectionMutationResponseValue> {
  const request = CreateSiteAuthConnectionRequest.parse({
    operationId: input.operationId,
    name: input.name,
    accountLabel: input.accountLabel,
    origins: input.origins,
    loginUrl: input.loginUrl,
    verificationUrlPrefixes: input.verificationUrlPrefixes,
    authorities: input.authorities,
    methods: input.methods,
    preferredIdentityId: input.preferredIdentityId,
    preferredPlacement: input.preferredPlacement,
    preferredNetworkRouteId: input.preferredNetworkRouteId,
    healthPolicy: input.healthPolicy,
  });
  const { operationId: _operationId, ...digestRequest } = request;
  const digest = operationDigest({
    version: 1,
    request: digestRequest,
    actorSubjectId: input.actorSubjectId,
  });
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await lockOperation(scopedDb, request.operationId);
      const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (existing) {
        assertOperation(existing, {
          resourceKind: "site_auth_connection",
          kind: "create",
          requestDigest: digest,
          actorSubjectId: input.actorSubjectId,
        });
        const response = SiteAuthConnectionMutationResponse.parse(existing.result);
        return { ...response, replayed: true };
      }
      await validateSiteAuthReferences(scopedDb, input.workspaceId, {
        authorities: request.authorities,
        preferredIdentityId: request.preferredIdentityId,
        preferredNetworkRouteId: request.preferredNetworkRouteId,
      });
      const id = randomUUID();
      const [row] = await scopedDb
        .insert(schema.siteAuthConnections)
        .values({
          id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: request.name,
          accountLabel: request.accountLabel,
          origins: request.origins,
          loginUrl: request.loginUrl,
          verificationUrlPrefixes: request.verificationUrlPrefixes,
          authorities: request.authorities,
          methods: request.methods,
          preferredIdentityId: request.preferredIdentityId,
          preferredPlacement: request.preferredPlacement,
          preferredNetworkRouteId: request.preferredNetworkRouteId,
          healthPolicy: request.healthPolicy,
          nextCheckAt: nextMaintainedAuthCheck("active", request.healthPolicy, null),
          createOperationId: request.operationId,
          createdBySubjectId: input.actorSubjectId,
          updatedBySubjectId: input.actorSubjectId,
        })
        .returning();
      if (!row) throw new Error("Site auth connection insert returned no row");
      const response = SiteAuthConnectionMutationResponse.parse({
        connection: siteAuthConnectionFromRow(row),
        operationId: request.operationId,
        replayed: false,
      });
      await insertCompletedOperation(scopedDb, {
        operationId: request.operationId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        resourceKind: "site_auth_connection",
        resourceId: id,
        kind: "create",
        requestDigest: digest,
        resultVersion: row.version,
        result: response,
        actorSubjectId: input.actorSubjectId,
      });
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (postgresConstraint(error) === "site_auth_connections_workspace_active_name_uq") {
      throw new InteractionResourceConflictError(
        "An active site auth connection already uses this name",
      );
    }
    throw error;
  }
}

export async function updateSiteAuthConnection(
  db: Database,
  input: InteractionMutationScope & {
    siteAuthConnectionId: string;
  } & UpdateSiteAuthConnectionRequestValue,
): Promise<SiteAuthConnectionMutationResponseValue> {
  const request = UpdateSiteAuthConnectionRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
    ...(input.origins !== undefined ? { origins: input.origins } : {}),
    ...(input.loginUrl !== undefined ? { loginUrl: input.loginUrl } : {}),
    ...(input.verificationUrlPrefixes !== undefined
      ? { verificationUrlPrefixes: input.verificationUrlPrefixes }
      : {}),
    ...(input.authorities !== undefined ? { authorities: input.authorities } : {}),
    ...(input.methods !== undefined ? { methods: input.methods } : {}),
    ...(input.preferredIdentityId !== undefined
      ? { preferredIdentityId: input.preferredIdentityId }
      : {}),
    ...(input.preferredPlacement !== undefined
      ? { preferredPlacement: input.preferredPlacement }
      : {}),
    ...(input.preferredNetworkRouteId !== undefined
      ? { preferredNetworkRouteId: input.preferredNetworkRouteId }
      : {}),
    ...(input.healthPolicy !== undefined ? { healthPolicy: input.healthPolicy } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
  const {
    operationId: _operationId,
    expectedVersion: _expectedVersion,
    ...candidatePatch
  } = request;
  const digest = operationDigest({
    version: 1,
    siteAuthConnectionId: input.siteAuthConnectionId,
    request: { expectedVersion: request.expectedVersion, ...candidatePatch },
    actorSubjectId: input.actorSubjectId,
  });
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await lockOperation(scopedDb, request.operationId);
      const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (existing) {
        assertOperation(existing, {
          resourceKind: "site_auth_connection",
          resourceId: input.siteAuthConnectionId,
          kind: "update",
          requestDigest: digest,
          actorSubjectId: input.actorSubjectId,
        });
        const response = SiteAuthConnectionMutationResponse.parse(existing.result);
        return { ...response, replayed: true };
      }
      const [current] = await scopedDb
        .select()
        .from(schema.siteAuthConnections)
        .where(
          and(
            eq(schema.siteAuthConnections.workspaceId, input.workspaceId),
            eq(schema.siteAuthConnections.id, input.siteAuthConnectionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) throw new InteractionResourceNotFoundError("Site auth connection not found");
      if (current.version !== request.expectedVersion) {
        throw new InteractionResourceConflictError(
          "Site auth connection changed before this update",
        );
      }
      const currentValue = siteAuthConnectionFromRow(current);
      const candidate = SiteAuthConnection.parse({
        ...currentValue,
        ...candidatePatch,
        id: current.id,
        accountId: current.accountId,
        workspaceId: current.workspaceId,
        version: current.version + 1,
        createdBySubjectId: current.createdBySubjectId,
        createdAt: iso(current.createdAt),
        updatedAt: new Date().toISOString(),
      });
      await validateSiteAuthUpdateReferences(scopedDb, input.workspaceId, currentValue, candidate);
      const [row] = await scopedDb
        .update(schema.siteAuthConnections)
        .set({
          name: candidate.name,
          accountLabel: candidate.accountLabel,
          status: candidate.status,
          origins: candidate.origins,
          loginUrl: candidate.loginUrl,
          verificationUrlPrefixes: candidate.verificationUrlPrefixes,
          authorities: candidate.authorities,
          methods: candidate.methods,
          preferredIdentityId: candidate.preferredIdentityId,
          preferredPlacement: candidate.preferredPlacement,
          preferredNetworkRouteId: candidate.preferredNetworkRouteId,
          healthPolicy: candidate.healthPolicy,
          nextCheckAt: nextMaintainedAuthCheck(
            candidate.status,
            candidate.healthPolicy,
            current.lastCheckedAt,
          ),
          version: candidate.version,
          updatedBySubjectId: input.actorSubjectId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.siteAuthConnections.workspaceId, input.workspaceId),
            eq(schema.siteAuthConnections.id, input.siteAuthConnectionId),
            eq(schema.siteAuthConnections.version, request.expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        throw new InteractionResourceConflictError("Site auth connection update lost its fence");
      }
      const response = SiteAuthConnectionMutationResponse.parse({
        connection: siteAuthConnectionFromRow(row),
        operationId: request.operationId,
        replayed: false,
      });
      await insertCompletedOperation(scopedDb, {
        operationId: request.operationId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        resourceKind: "site_auth_connection",
        resourceId: input.siteAuthConnectionId,
        kind: "update",
        requestDigest: digest,
        resultVersion: row.version,
        result: response,
        actorSubjectId: input.actorSubjectId,
      });
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (postgresConstraint(error) === "site_auth_connections_workspace_active_name_uq") {
      throw new InteractionResourceConflictError(
        "An active site auth connection already uses this name",
      );
    }
    throw error;
  }
}

function authRunFromRow(row: AuthRunRow): AuthRunValue {
  return AuthRun.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    siteAuthConnectionId: row.siteAuthConnectionId,
    browserSessionId: row.browserSessionId,
    targetId: row.targetId,
    controllerGeneration: row.controllerGeneration,
    targetGeneration: row.targetGeneration,
    documentGeneration: row.documentGeneration,
    purpose: row.purpose,
    methodId: row.methodId,
    authorityId: row.authorityId,
    state: row.state,
    choices: row.choices,
    pendingFields: row.pendingFields,
    externalAction: row.externalAction,
    interventionId: row.interventionId,
    verifiedUrl: row.verifiedUrl,
    failureCode: row.failureCode,
    version: row.version,
    operationId: row.operationId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    settledAt: row.settledAt ? iso(row.settledAt) : null,
  });
}

/**
 * Project only terminal authentication evidence. `healthSequence` is allocated
 * by PostgreSQL when a run starts, so an older browser may finish later without
 * overwriting evidence from a newer run. A cancelled run carries no evidence.
 */
async function projectSettledAuthRunHealth(
  db: Database,
  input: { run: AuthRunRow; actorSubjectId: string },
): Promise<boolean> {
  const { run } = input;
  if ((run.state !== "verified" && run.state !== "failed") || !run.settledAt) return false;
  const [connection] = await db
    .select()
    .from(schema.siteAuthConnections)
    .where(
      and(
        eq(schema.siteAuthConnections.workspaceId, run.workspaceId),
        eq(schema.siteAuthConnections.id, run.siteAuthConnectionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!connection) throw new InteractionResourceNotFoundError("Site auth connection not found");
  const checkedAt = run.settledAt;
  const intervalSeconds = connection.healthPolicy.intervalSeconds;
  const nextCheckAt =
    connection.status === "active" &&
    connection.healthPolicy.mode === "maintained" &&
    intervalSeconds !== null
      ? run.state === "failed" &&
        run.purpose === "health_check" &&
        connection.healthPolicy.automaticRepair
        ? checkedAt
        : new Date(checkedAt.getTime() + intervalSeconds * 1_000)
      : null;
  const failureState = run.purpose === "repair" ? "failed" : "needs_repair";
  const [projected] = await db
    .update(schema.siteAuthConnections)
    .set({
      verificationState: run.state === "verified" ? "verified" : failureState,
      ...(run.state === "verified"
        ? {
            lastVerifiedAt: checkedAt,
            lastVerifiedUrl: run.verifiedUrl,
            repairCode: null,
          }
        : { repairCode: run.failureCode }),
      lastCheckedAt: checkedAt,
      nextCheckAt,
      healthSequence: run.healthSequence,
      version: sql`${schema.siteAuthConnections.version} + 1`,
      updatedBySubjectId: input.actorSubjectId,
      updatedAt: checkedAt,
    })
    .where(
      and(
        eq(schema.siteAuthConnections.workspaceId, run.workspaceId),
        eq(schema.siteAuthConnections.id, run.siteAuthConnectionId),
        sql`${schema.siteAuthConnections.healthSequence} < ${run.healthSequence}`,
      ),
    )
    .returning({ id: schema.siteAuthConnections.id });
  return Boolean(projected);
}

async function loadAuthRunRow(
  db: Database,
  workspaceId: string,
  authRunId: string,
): Promise<AuthRunRow | null> {
  const [row] = await db
    .select()
    .from(schema.authRuns)
    .where(and(eq(schema.authRuns.workspaceId, workspaceId), eq(schema.authRuns.id, authRunId)))
    .limit(1);
  return row ?? null;
}

function assertAuthSelection(
  connection: SiteAuthConnectionValue,
  selection: { methodId?: string | null; authorityId?: string | null },
): void {
  const method = selection.methodId
    ? connection.methods.find((candidate) => candidate.id === selection.methodId)
    : null;
  const authority = selection.authorityId
    ? connection.authorities.find((candidate) => candidate.id === selection.authorityId)
    : null;
  if (selection.methodId && !method) {
    throw new InteractionResourceStateError("Auth method is not configured");
  }
  if (selection.authorityId && !authority) {
    throw new InteractionResourceStateError("Auth authority is not configured");
  }
  if (method && authority && !method.authorityIds.includes(authority.id)) {
    throw new InteractionResourceStateError(
      "Auth authority does not belong to the selected method",
    );
  }
}

const AUTH_RUN_TRANSITIONS: Readonly<
  Record<AuthRunRow["state"], ReadonlySet<AuthRunRow["state"]>>
> = {
  discovering: new Set([
    "awaiting_choice",
    "awaiting_secret",
    "awaiting_external_action",
    "working",
    "failed",
    "cancelled",
  ]),
  awaiting_choice: new Set([
    "awaiting_choice",
    "awaiting_secret",
    "awaiting_external_action",
    "working",
    "failed",
    "cancelled",
  ]),
  awaiting_secret: new Set([
    "awaiting_secret",
    "awaiting_external_action",
    "working",
    "failed",
    "cancelled",
  ]),
  awaiting_external_action: new Set([
    "awaiting_external_action",
    "awaiting_secret",
    "working",
    "failed",
    "cancelled",
  ]),
  working: new Set([
    "working",
    "awaiting_choice",
    "awaiting_secret",
    "awaiting_external_action",
    "failed",
    "cancelled",
  ]),
  verified: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

type ProtectedAuthOperationMetadata = {
  schemaVersion: 1;
  authRunVersion: number;
  authority: SiteAuthAuthorityValue;
  origins: string[];
  fields: Array<{
    id: string;
    purpose: "identifier" | "password" | "secret" | "totp";
  }>;
  credentialVersion: number | null;
};

type ExternalAuthOperationMetadata = {
  schemaVersion: 1;
  authRunVersion: number;
  authority: Extract<SiteAuthAuthorityValue, { kind: "external_provider" }>;
};

export type ExternalAuthPreparation = {
  run: AuthRunValue;
  authority: ExternalAuthOperationMetadata["authority"];
  operationState: ResourceOperationRow["state"];
  response: ExternalAuthRunResponseValue | null;
  replayed: boolean;
};

export type ProtectedAuthFillPreparation = {
  run: AuthRunValue;
  authority: SiteAuthAuthorityValue;
  origins: string[];
  credentialVersion: number | null;
  operationState: ResourceOperationRow["state"];
  response: ProtectedAuthFillResponseValue | null;
  replayed: boolean;
};

function protectedAuthFillDigest(
  authRunId: string,
  request: ProtectedAuthFillRequestValue,
  actorSubjectId: string,
): string {
  const { operationId: _operationId, ...digestRequest } = request;
  return operationDigest({
    version: 1,
    authRunId,
    request: digestRequest,
    actorSubjectId,
  });
}

function parseExternalAuthRunRequest(
  input: ExternalAuthRunRequestValue,
): ExternalAuthRunRequestValue {
  return ExternalAuthRunRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
    action: input.action,
  });
}

function externalAuthDigest(
  authRunId: string,
  request: ExternalAuthRunRequestValue,
  actorSubjectId: string,
): string {
  const { operationId: _operationId, ...digestRequest } = request;
  return operationDigest({
    version: 1,
    authRunId,
    request: digestRequest,
    actorSubjectId,
  });
}

function externalAuthOperationMetadata(value: unknown): ExternalAuthOperationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionResourceStateError("External-auth operation metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  const authority = SiteAuthAuthority.parse(record.authority);
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.authRunVersion) ||
    (record.authRunVersion as number) < 1 ||
    authority.kind !== "external_provider"
  ) {
    throw new InteractionResourceStateError("External-auth operation metadata is invalid");
  }
  return {
    schemaVersion: 1,
    authRunVersion: record.authRunVersion as number,
    authority,
  };
}

function externalAuthPreparationFromOperation(
  operation: ResourceOperationRow,
  run: AuthRunRow,
): ExternalAuthPreparation {
  const metadata = externalAuthOperationMetadata(operation.metadata);
  return {
    run: authRunFromRow(run),
    authority: metadata.authority,
    operationState: operation.state,
    response:
      operation.state === "completed" && operation.result
        ? {
            ...ExternalAuthRunResponse.parse(operation.result),
            replayed: true,
          }
        : null,
    replayed: operation.state === "completed",
  };
}

function parseProtectedAuthFillRequest(
  input: ProtectedAuthFillRequestValue,
): ProtectedAuthFillRequestValue {
  return ProtectedAuthFillRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
    expectedTargetGeneration: input.expectedTargetGeneration,
    expectedDocumentGeneration: input.expectedDocumentGeneration,
    expectedFrameId: input.expectedFrameId,
    authorityId: input.authorityId,
    fields: input.fields,
    submit: input.submit,
  });
}

function protectedAuthPreparationFromOperation(
  operation: ResourceOperationRow,
  run: AuthRunRow,
): ProtectedAuthFillPreparation {
  const metadata = protectedAuthOperationMetadata(operation.metadata);
  return {
    run: authRunFromRow(run),
    authority: metadata.authority,
    origins: metadata.origins,
    credentialVersion: metadata.credentialVersion,
    operationState: operation.state,
    response:
      operation.state === "completed" && operation.result
        ? {
            ...ProtectedAuthFillResponse.parse(operation.result),
            replayed: true,
          }
        : null,
    replayed: operation.state === "completed",
  };
}

export async function getProtectedAuthFillPreparation(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
  } & ProtectedAuthFillRequestValue,
): Promise<ProtectedAuthFillPreparation | null> {
  const request = parseProtectedAuthFillRequest(input);
  const digest = protectedAuthFillDigest(input.authRunId, request, input.actorSubjectId);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const operation = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (!operation) return null;
      assertOperationIdentity(operation, {
        resourceKind: "auth_run",
        resourceId: input.authRunId,
        kind: "protected_fill",
        requestDigest: digest,
        actorSubjectId: input.actorSubjectId,
      });
      const run = await loadAuthRunRow(scopedDb, input.workspaceId, input.authRunId);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      return protectedAuthPreparationFromOperation(operation, run);
    },
    CONSISTENT_READ,
  );
}

function protectedAuthOperationMetadata(value: unknown): ProtectedAuthOperationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionResourceStateError("Protected-fill operation metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  const authority = SiteAuthAuthority.parse(record.authority);
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.authRunVersion) ||
    (record.authRunVersion as number) < 1 ||
    !Array.isArray(record.origins) ||
    record.origins.some(
      (origin) =>
        typeof origin !== "string" ||
        (() => {
          try {
            return new URL(origin).origin !== origin;
          } catch {
            return true;
          }
        })(),
    ) ||
    !Array.isArray(record.fields) ||
    record.fields.length < 1 ||
    record.fields.length > 32 ||
    !(
      record.credentialVersion === null ||
      (Number.isSafeInteger(record.credentialVersion) && (record.credentialVersion as number) > 0)
    )
  ) {
    throw new InteractionResourceStateError("Protected-fill operation metadata is invalid");
  }
  const purposes = new Set(["identifier", "password", "secret", "totp"]);
  const fields = record.fields.map((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new InteractionResourceStateError("Protected-fill operation metadata is invalid");
    }
    const candidate = field as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      candidate.id.length < 1 ||
      candidate.id.length > 512 ||
      typeof candidate.purpose !== "string" ||
      !purposes.has(candidate.purpose)
    ) {
      throw new InteractionResourceStateError("Protected-fill operation metadata is invalid");
    }
    return {
      id: candidate.id,
      purpose: candidate.purpose as ProtectedAuthOperationMetadata["fields"][number]["purpose"],
    };
  });
  if (new Set(fields.map((field) => field.id)).size !== fields.length) {
    throw new InteractionResourceStateError("Protected-fill operation metadata is invalid");
  }
  if ((authority.kind === "connection_fields") !== (record.credentialVersion !== null)) {
    throw new InteractionResourceStateError("Protected-fill credential metadata is invalid");
  }
  return {
    schemaVersion: 1,
    authRunVersion: record.authRunVersion as number,
    authority,
    origins: [...(record.origins as string[])],
    fields,
    credentialVersion: record.credentialVersion as number | null,
  };
}

function protectedAuthFields(
  authority: SiteAuthAuthorityValue,
  requested: readonly ProtectedAuthFillRequestValue["fields"][number][],
): ProtectedAuthOperationMetadata["fields"] {
  if (authority.kind === "external_provider") {
    throw new InteractionResourceStateError(
      "External auth providers cannot use protected field fill",
    );
  }
  const configured = new Map(authority.fields.map((field) => [field.id, field]));
  return requested.map((field) => {
    const match = configured.get(field.fieldId);
    if (!match) {
      throw new InteractionResourceStateError("Protected-fill field is not configured");
    }
    return { id: match.id, purpose: match.purpose };
  });
}

export async function listAuthRuns(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    browserSessionId?: string;
    siteAuthConnectionId?: string;
    includeSettled?: boolean;
  },
): Promise<AuthRunListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const predicates = [eq(schema.authRuns.workspaceId, input.workspaceId)];
      if (input.browserSessionId) {
        predicates.push(eq(schema.authRuns.browserSessionId, input.browserSessionId));
      }
      if (input.siteAuthConnectionId) {
        predicates.push(eq(schema.authRuns.siteAuthConnectionId, input.siteAuthConnectionId));
      }
      if (!input.includeSettled) predicates.push(sql`${schema.authRuns.settledAt} is null`);
      const runs = await scopedDb
        .select()
        .from(schema.authRuns)
        .where(and(...predicates))
        .orderBy(asc(schema.authRuns.createdAt), asc(schema.authRuns.id));
      return AuthRunListResponse.parse({ runs: runs.map(authRunFromRow) });
    },
    CONSISTENT_READ,
  );
}

export async function getAuthRun(
  db: Database,
  input: { accountId: string; workspaceId: string; authRunId: string },
): Promise<AuthRunValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const row = await loadAuthRunRow(scopedDb, input.workspaceId, input.authRunId);
      if (!row) throw new InteractionResourceNotFoundError("Auth run not found");
      return authRunFromRow(row);
    },
    CONSISTENT_READ,
  );
}

export type ExternalAuthInteractiveContext = {
  run: AuthRunValue;
  authority: Extract<SiteAuthAuthorityValue, { kind: "external_provider" }>;
};

/** Resolve only the durable authority needed to reveal an external provider's
 * hosted login UI. The hosted URL itself is deliberately never persisted. */
export async function getExternalAuthInteractiveContext(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
  } & ExternalAuthInteractiveRequestValue,
): Promise<ExternalAuthInteractiveContext> {
  const request = ExternalAuthInteractiveRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
  });
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const run = await loadAuthRunRow(scopedDb, input.workspaceId, input.authRunId);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      if (run.settledAt || run.version !== request.expectedVersion) {
        throw new InteractionResourceConflictError(
          "Auth run changed before its hosted login flow was opened",
        );
      }
      if (run.state !== "awaiting_external_action" || !run.externalAction || !run.interventionId) {
        throw new InteractionResourceStateError("Auth run is not waiting for a hosted login flow");
      }
      const [browser] = await scopedDb
        .select({
          lifecycle: schema.browserSessions.lifecycle,
          controllerGeneration: schema.browserSessions.controllerGeneration,
        })
        .from(schema.browserSessions)
        .where(
          and(
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, run.browserSessionId),
          ),
        )
        .limit(1);
      if (
        !browser ||
        browser.lifecycle !== "active" ||
        browser.controllerGeneration !== run.controllerGeneration
      ) {
        throw new InteractionResourceConflictError(
          "Hosted login belongs to a stale browser controller",
        );
      }
      const connectionRow = await getSiteAuthConnectionRow(
        scopedDb,
        input.workspaceId,
        run.siteAuthConnectionId,
      );
      if (connectionRow.status !== "active") {
        throw new InteractionResourceStateError("Site auth connection is archived");
      }
      const connection = siteAuthConnectionFromRow(connectionRow);
      const authority = connection.authorities.find(
        (candidate) => candidate.id === run.authorityId,
      );
      if (!authority || authority.kind !== "external_provider") {
        throw new InteractionResourceStateError("Auth run has no external provider authority");
      }
      return { run: authRunFromRow(run), authority };
    },
    CONSISTENT_READ,
  );
}

export async function startAuthRun(
  db: Database,
  input: InteractionMutationScope & {
    browserSessionId: string;
    controllerGeneration: string;
  } & StartAuthRunRequestValue,
): Promise<AuthRunMutationResponseValue> {
  const request = StartAuthRunRequest.parse({
    operationId: input.operationId,
    siteAuthConnectionId: input.siteAuthConnectionId,
    targetId: input.targetId,
    expectedTargetGeneration: input.expectedTargetGeneration,
    expectedDocumentGeneration: input.expectedDocumentGeneration,
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    ...(input.methodId !== undefined ? { methodId: input.methodId } : {}),
    ...(input.authorityId !== undefined ? { authorityId: input.authorityId } : {}),
  });
  const { operationId: _operationId, ...digestRequest } = request;
  const digest = operationDigest({
    version: 1,
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    request: digestRequest,
    actorSubjectId: input.actorSubjectId,
  });
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
      await lockOperation(scopedDb, request.operationId);
      const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (existing) {
        assertOperation(existing, {
          resourceKind: "auth_run",
          kind: "start",
          requestDigest: digest,
          actorSubjectId: input.actorSubjectId,
        });
        const response = AuthRunMutationResponse.parse(existing.result);
        return { ...response, replayed: true };
      }
      const [browser] = await scopedDb
        .select()
        .from(schema.browserSessions)
        .where(
          and(
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, input.browserSessionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!browser) throw new InteractionResourceNotFoundError("Browser session not found");
      if (
        browser.lifecycle !== "active" ||
        !browser.controllerGeneration ||
        browser.controllerGeneration !== input.controllerGeneration
      ) {
        throw new InteractionResourceStateError("Browser session is not active");
      }
      const authConnection = await getSiteAuthConnectionRow(
        scopedDb,
        input.workspaceId,
        request.siteAuthConnectionId,
      );
      if (authConnection.status !== "active") {
        throw new InteractionResourceStateError("Site auth connection is archived");
      }
      const connection = siteAuthConnectionFromRow(authConnection);
      assertAuthSelection(connection, {
        methodId: request.methodId ?? null,
        authorityId: request.authorityId ?? null,
      });
      const id = randomUUID();
      const [row] = await scopedDb
        .insert(schema.authRuns)
        .values({
          id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          siteAuthConnectionId: request.siteAuthConnectionId,
          browserSessionId: input.browserSessionId,
          targetId: request.targetId,
          controllerGeneration: browser.controllerGeneration,
          targetGeneration: request.expectedTargetGeneration,
          documentGeneration: request.expectedDocumentGeneration,
          purpose: request.purpose ?? "authenticate",
          methodId: request.methodId ?? null,
          authorityId: request.authorityId ?? null,
          operationId: request.operationId,
          createdBySubjectId: input.actorSubjectId,
        })
        .returning();
      if (!row) throw new Error("Auth run insert returned no row");
      const response = AuthRunMutationResponse.parse({
        run: authRunFromRow(row),
        operationId: request.operationId,
        replayed: false,
      });
      await insertCompletedOperation(scopedDb, {
        operationId: request.operationId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        resourceKind: "auth_run",
        resourceId: id,
        kind: "start",
        requestDigest: digest,
        resultVersion: row.version,
        result: response,
        actorSubjectId: input.actorSubjectId,
      });
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (postgresConstraint(error) === "auth_runs_active_browser_target_uq") {
      throw new InteractionResourceConflictError(
        "This browser target already has an active auth run",
      );
    }
    throw error;
  }
}

export async function reportAuthRun(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
    controllerGeneration: string;
  } & ReportAuthRunRequestValue,
): Promise<AuthRunMutationResponseValue> {
  const request = ReportAuthRunRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
    ...(input.methodId !== undefined ? { methodId: input.methodId } : {}),
    ...(input.authorityId !== undefined ? { authorityId: input.authorityId } : {}),
    state: input.state,
    ...(input.choices !== undefined ? { choices: input.choices } : {}),
    ...(input.pendingFields !== undefined ? { pendingFields: input.pendingFields } : {}),
    ...(input.externalAction !== undefined ? { externalAction: input.externalAction } : {}),
    ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
  });
  const { operationId: _operationId, ...digestRequest } = request;
  const digest = operationDigest({
    version: 1,
    authRunId: input.authRunId,
    controllerGeneration: input.controllerGeneration,
    request: digestRequest,
    actorSubjectId: input.actorSubjectId,
  });
  return await withRlsContext(db, input, async (scopedDb) => {
    await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
    await lockOperation(scopedDb, request.operationId);
    const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
    if (existing) {
      assertOperation(existing, {
        resourceKind: "auth_run",
        resourceId: input.authRunId,
        kind: "report",
        requestDigest: digest,
        actorSubjectId: input.actorSubjectId,
      });
      const response = AuthRunMutationResponse.parse(existing.result);
      return { ...response, replayed: true };
    }
    const [current] = await scopedDb
      .select()
      .from(schema.authRuns)
      .where(
        and(
          eq(schema.authRuns.workspaceId, input.workspaceId),
          eq(schema.authRuns.id, input.authRunId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw new InteractionResourceNotFoundError("Auth run not found");
    if (current.controllerGeneration !== input.controllerGeneration) {
      throw new InteractionResourceConflictError("Auth run belongs to a stale browser controller");
    }
    if (current.version !== request.expectedVersion) {
      throw new InteractionResourceConflictError("Auth run changed before this report");
    }
    if (!AUTH_RUN_TRANSITIONS[current.state].has(request.state)) {
      throw new InteractionResourceStateError(
        `Auth run cannot transition from ${current.state} to ${request.state}`,
      );
    }
    const authConnection = await getSiteAuthConnectionRow(
      scopedDb,
      input.workspaceId,
      current.siteAuthConnectionId,
    );
    assertAuthSelection(siteAuthConnectionFromRow(authConnection), {
      methodId: request.methodId ?? current.methodId,
      authorityId: request.authorityId ?? current.authorityId,
    });
    const settled = request.state === "failed" || request.state === "cancelled";
    const [row] = await scopedDb
      .update(schema.authRuns)
      .set({
        methodId: request.methodId ?? current.methodId,
        authorityId: request.authorityId ?? current.authorityId,
        state: request.state,
        choices: request.choices ?? [],
        pendingFields: request.pendingFields ?? [],
        externalAction: request.externalAction ?? null,
        failureCode: request.state === "failed" ? request.failureCode! : null,
        version: current.version + 1,
        updatedAt: sql`now()`,
        settledAt: settled ? sql`now()` : null,
      })
      .where(
        and(
          eq(schema.authRuns.workspaceId, input.workspaceId),
          eq(schema.authRuns.id, input.authRunId),
          eq(schema.authRuns.version, request.expectedVersion),
          eq(schema.authRuns.controllerGeneration, input.controllerGeneration),
        ),
      )
      .returning();
    if (!row) throw new InteractionResourceConflictError("Auth run report lost its fence");
    await projectSettledAuthRunHealth(scopedDb, {
      run: row,
      actorSubjectId: input.actorSubjectId,
    });
    const response = AuthRunMutationResponse.parse({
      run: authRunFromRow(row),
      operationId: request.operationId,
      replayed: false,
    });
    await insertCompletedOperation(scopedDb, {
      operationId: request.operationId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      resourceKind: "auth_run",
      resourceId: input.authRunId,
      kind: "report",
      requestDigest: digest,
      resultVersion: row.version,
      result: response,
      actorSubjectId: input.actorSubjectId,
    });
    await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
    return response;
  });
}

export async function getExternalAuthPreparation(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
  } & ExternalAuthRunRequestValue,
): Promise<ExternalAuthPreparation | null> {
  const request = parseExternalAuthRunRequest(input);
  const digest = externalAuthDigest(input.authRunId, request, input.actorSubjectId);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const operation = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (!operation) return null;
      assertOperationIdentity(operation, {
        resourceKind: "auth_run",
        resourceId: input.authRunId,
        kind: "external_auth",
        requestDigest: digest,
        actorSubjectId: input.actorSubjectId,
      });
      const run = await loadAuthRunRow(scopedDb, input.workspaceId, input.authRunId);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      return externalAuthPreparationFromOperation(operation, run);
    },
    CONSISTENT_READ,
  );
}

export async function prepareExternalAuth(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
  } & ExternalAuthRunRequestValue,
): Promise<ExternalAuthPreparation> {
  const request = parseExternalAuthRunRequest(input);
  const digest = externalAuthDigest(input.authRunId, request, input.actorSubjectId);
  return await withRlsContext(db, input, async (scopedDb) => {
    await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
    await setSubjectRlsContext(scopedDb, input.actorSubjectId);
    await lockOperation(scopedDb, request.operationId);
    const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
    if (existing) {
      assertOperationIdentity(existing, {
        resourceKind: "auth_run",
        resourceId: input.authRunId,
        kind: "external_auth",
        requestDigest: digest,
        actorSubjectId: input.actorSubjectId,
      });
      const run = await loadAuthRunRow(scopedDb, input.workspaceId, input.authRunId);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      return externalAuthPreparationFromOperation(existing, run);
    }

    const [run] = await scopedDb
      .select()
      .from(schema.authRuns)
      .where(
        and(
          eq(schema.authRuns.workspaceId, input.workspaceId),
          eq(schema.authRuns.id, input.authRunId),
        ),
      )
      .for("update")
      .limit(1);
    if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
    if (run.settledAt) throw new InteractionResourceStateError("Auth run is already settled");
    if (run.version !== request.expectedVersion) {
      throw new InteractionResourceConflictError("Auth run changed before external authentication");
    }
    const [browser] = await scopedDb
      .select({
        lifecycle: schema.browserSessions.lifecycle,
        controllerGeneration: schema.browserSessions.controllerGeneration,
      })
      .from(schema.browserSessions)
      .where(
        and(
          eq(schema.browserSessions.workspaceId, input.workspaceId),
          eq(schema.browserSessions.id, run.browserSessionId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !browser ||
      browser.lifecycle !== "active" ||
      browser.controllerGeneration !== run.controllerGeneration
    ) {
      throw new InteractionResourceConflictError(
        "External authentication belongs to a stale browser controller",
      );
    }
    const connectionRow = await getSiteAuthConnectionRow(
      scopedDb,
      input.workspaceId,
      run.siteAuthConnectionId,
    );
    if (connectionRow.status !== "active") {
      throw new InteractionResourceStateError("Site auth connection is archived");
    }
    const connection = siteAuthConnectionFromRow(connectionRow);
    if (!run.authorityId) {
      throw new InteractionResourceStateError(
        "Auth run must select an external authority before it can start",
      );
    }
    assertAuthSelection(connection, {
      methodId: run.methodId,
      authorityId: run.authorityId,
    });
    const selected = connection.authorities.find((authority) => authority.id === run.authorityId);
    if (!selected || selected.kind !== "external_provider") {
      throw new InteractionResourceStateError(
        "Selected auth authority is not an external provider",
      );
    }
    const metadata: ExternalAuthOperationMetadata = {
      schemaVersion: 1,
      authRunVersion: run.version,
      authority: selected,
    };
    await scopedDb.insert(schema.interactionResourceOperations).values({
      operationId: request.operationId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      resourceKind: "auth_run",
      resourceId: input.authRunId,
      kind: "external_auth",
      requestDigest: digest,
      metadata,
      state: "prepared",
      actorSubjectId: input.actorSubjectId,
    });
    return {
      run: authRunFromRow(run),
      authority: selected,
      operationState: "prepared",
      response: null,
      replayed: false,
    };
  });
}

export async function dispatchExternalAuth(
  db: Database,
  input: InteractionMutationScope & { authRunId: string; operationId: string },
): Promise<ResourceOperationRow["state"]> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await lockOperation(scopedDb, input.operationId);
    const operation = await loadOperation(scopedDb, input.workspaceId, input.operationId);
    if (!operation) throw new InteractionResourceNotFoundError("External-auth operation not found");
    assertExternalAuthOperationBinding(operation, input);
    if (operation.state !== "prepared") return operation.state;
    const [dispatched] = await scopedDb
      .update(schema.interactionResourceOperations)
      .set({ state: "dispatched" })
      .where(
        and(
          eq(schema.interactionResourceOperations.operationId, input.operationId),
          eq(schema.interactionResourceOperations.state, "prepared"),
        ),
      )
      .returning({ state: schema.interactionResourceOperations.state });
    if (!dispatched) {
      throw new InteractionResourceConflictError("External-auth dispatch lost its fence");
    }
    return dispatched.state;
  });
}

export async function completeExternalAuth(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
    operationId: string;
    result: BrowserExternalAuthResultValue;
    target?: {
      id: string;
      targetGeneration: string;
      documentGeneration: string | null;
    };
    intervention?: {
      originatingSessionId: string;
      originatingTurnId?: string | null;
      originatingAttemptId?: string | null;
      originatingToolOperationId?: string | null;
      expiresInSeconds: number;
    };
  },
): Promise<ExternalAuthRunResponseValue> {
  const providerResult = BrowserExternalAuthResult.parse(input.result);
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await lockOperation(scopedDb, input.operationId);
      const operation = await loadOperation(scopedDb, input.workspaceId, input.operationId);
      if (!operation)
        throw new InteractionResourceNotFoundError("External-auth operation not found");
      assertExternalAuthOperationBinding(operation, input);
      if (operation.state === "completed" && operation.result) {
        return {
          ...ExternalAuthRunResponse.parse(operation.result),
          replayed: true,
        };
      }
      if (operation.state !== "dispatched") {
        throw new InteractionResourceStateError(
          `External-auth operation is ${operation.state.replace("_", " ")}`,
        );
      }
      const metadata = externalAuthOperationMetadata(operation.metadata);
      const [run] = await scopedDb
        .select()
        .from(schema.authRuns)
        .where(
          and(
            eq(schema.authRuns.workspaceId, input.workspaceId),
            eq(schema.authRuns.id, input.authRunId),
          ),
        )
        .for("update")
        .limit(1);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      if (run.version !== metadata.authRunVersion || run.settledAt) {
        throw new InteractionResourceConflictError("Auth run changed after external auth began");
      }
      if ((providerResult.state === "authenticated") !== Boolean(input.target)) {
        throw new InteractionResourceStateError(
          "Authenticated external auth requires the current browser target",
        );
      }
      if ((providerResult.state === "needs_human") !== Boolean(input.intervention)) {
        throw new InteractionResourceStateError(
          "Human external auth requires intervention provenance",
        );
      }
      const nextState =
        providerResult.state === "needs_human"
          ? "awaiting_external_action"
          : providerResult.state === "failed"
            ? "failed"
            : "working";
      if (!AUTH_RUN_TRANSITIONS[run.state].has(nextState)) {
        throw new InteractionResourceStateError(
          `Auth run cannot transition from ${run.state} to ${nextState}`,
        );
      }

      if (providerResult.profileLoaded) {
        const otherRuns = await scopedDb
          .update(schema.authRuns)
          .set({
            state: "failed",
            choices: [],
            pendingFields: [],
            externalAction: null,
            interventionId: null,
            verifiedUrl: null,
            failureCode: "browser_profile_reconfigured",
            version: sql`${schema.authRuns.version} + 1`,
            updatedAt: sql`now()`,
            settledAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.authRuns.workspaceId, input.workspaceId),
              eq(schema.authRuns.browserSessionId, run.browserSessionId),
              sql`${schema.authRuns.id} <> ${run.id}`,
              sql`${schema.authRuns.settledAt} is null`,
            ),
          )
          .returning();
        if (otherRuns.length > 0) {
          const otherIds = otherRuns.map((entry) => entry.id);
          await scopedDb
            .update(schema.interactionResourceOperations)
            .set({
              state: "failed",
              errorCode: "browser_profile_reconfigured",
              settledAt: sql`now()`,
            })
            .where(
              and(
                eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
                eq(schema.interactionResourceOperations.resourceKind, "auth_run"),
                inArray(schema.interactionResourceOperations.resourceId, otherIds),
                inArray(schema.interactionResourceOperations.state, ["prepared", "dispatched"]),
              ),
            );
          await scopedDb
            .update(schema.interactionInterventions)
            .set({
              status: "cancelled",
              responseActorSubjectId: input.actorSubjectId,
              version: sql`${schema.interactionInterventions.version} + 1`,
              updatedAt: sql`now()`,
              settledAt: sql`now()`,
            })
            .where(
              and(
                eq(schema.interactionInterventions.workspaceId, input.workspaceId),
                inArray(schema.interactionInterventions.authRunId, otherIds),
                eq(schema.interactionInterventions.status, "open"),
              ),
            );
          for (const other of otherRuns) {
            await projectSettledAuthRunHealth(scopedDb, {
              run: other,
              actorSubjectId: input.actorSubjectId,
            });
          }
        }
      }

      let interventionId: string | null = null;
      if (providerResult.state === "needs_human") {
        const currentIntervention = run.interventionId
          ? (
              await scopedDb
                .select()
                .from(schema.interactionInterventions)
                .where(
                  and(
                    eq(schema.interactionInterventions.workspaceId, input.workspaceId),
                    eq(schema.interactionInterventions.id, run.interventionId),
                  ),
                )
                .for("update")
                .limit(1)
            )[0]
          : null;
        if (currentIntervention?.status === "open" && currentIntervention.expiresAt > new Date()) {
          interventionId = currentIntervention.id;
        } else {
          if (currentIntervention?.status === "open") {
            await scopedDb
              .update(schema.interactionInterventions)
              .set({
                status: "expired",
                version: currentIntervention.version + 1,
                updatedAt: sql`now()`,
                settledAt: sql`now()`,
              })
              .where(
                and(
                  eq(schema.interactionInterventions.id, currentIntervention.id),
                  eq(schema.interactionInterventions.version, currentIntervention.version),
                  eq(schema.interactionInterventions.status, "open"),
                ),
              );
          }
          const intervention = input.intervention!;
          if (
            (intervention.originatingAttemptId && !intervention.originatingTurnId) ||
            (intervention.originatingToolOperationId && !intervention.originatingAttemptId)
          ) {
            throw new InteractionResourceStateError(
              "External-auth intervention provenance is incomplete",
            );
          }
          interventionId = randomUUID();
          const [created] = await scopedDb
            .insert(schema.interactionInterventions)
            .values({
              id: interventionId,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              resourceKind: "browser_session",
              resourceId: run.browserSessionId,
              targetId: run.targetId,
              controllerGeneration: run.controllerGeneration,
              targetGeneration: run.targetGeneration,
              documentGeneration: run.documentGeneration,
              kind: "external_action",
              reason: providerResult.externalAction!.label,
              authRunId: run.id,
              originatingSessionId: intervention.originatingSessionId,
              originatingTurnId: intervention.originatingTurnId ?? null,
              originatingAttemptId: intervention.originatingAttemptId ?? null,
              originatingToolOperationId: intervention.originatingToolOperationId ?? null,
              operationId: input.operationId,
              expiresAt: providerResult.externalAction!.expiresAt
                ? new Date(providerResult.externalAction!.expiresAt)
                : sql`now() + (${intervention.expiresInSeconds} * interval '1 second')`,
            })
            .returning({ id: schema.interactionInterventions.id });
          if (!created) throw new Error("External-auth intervention insert returned no row");
        }
      } else if (run.interventionId) {
        await scopedDb
          .update(schema.interactionInterventions)
          .set({
            status: "completed",
            responseActorSubjectId: input.actorSubjectId,
            version: sql`${schema.interactionInterventions.version} + 1`,
            updatedAt: sql`now()`,
            settledAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.interactionInterventions.workspaceId, input.workspaceId),
              eq(schema.interactionInterventions.id, run.interventionId),
              eq(schema.interactionInterventions.status, "open"),
            ),
          );
      }

      const [updated] = await scopedDb
        .update(schema.authRuns)
        .set({
          authorityId: metadata.authority.id,
          state: nextState,
          targetId: input.target?.id ?? run.targetId,
          targetGeneration: input.target?.targetGeneration ?? run.targetGeneration,
          documentGeneration: input.target?.documentGeneration ?? run.documentGeneration,
          choices: [],
          pendingFields: [],
          externalAction:
            providerResult.state === "needs_human" ? providerResult.externalAction : null,
          interventionId,
          verifiedUrl: null,
          failureCode: providerResult.state === "failed" ? providerResult.failureCode : null,
          version: run.version + 1,
          updatedAt: sql`now()`,
          settledAt: providerResult.state === "failed" ? sql`now()` : null,
        })
        .where(
          and(
            eq(schema.authRuns.workspaceId, input.workspaceId),
            eq(schema.authRuns.id, input.authRunId),
            eq(schema.authRuns.version, metadata.authRunVersion),
            sql`${schema.authRuns.settledAt} is null`,
          ),
        )
        .returning();
      if (!updated) {
        throw new InteractionResourceConflictError("External-auth settlement lost its auth fence");
      }
      await projectSettledAuthRunHealth(scopedDb, {
        run: updated,
        actorSubjectId: input.actorSubjectId,
      });
      const status =
        providerResult.state === "authenticated"
          ? "ready_to_verify"
          : providerResult.state === "needs_human"
            ? "needs_human"
            : providerResult.state === "failed"
              ? "failed"
              : "working";
      const response = ExternalAuthRunResponse.parse({
        run: authRunFromRow(updated),
        status,
        operationId: input.operationId,
        replayed: false,
      });
      const [completed] = await scopedDb
        .update(schema.interactionResourceOperations)
        .set({
          state: "completed",
          resultVersion: updated.version,
          result: response,
          settledAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.interactionResourceOperations.operationId, input.operationId),
            eq(schema.interactionResourceOperations.state, "dispatched"),
          ),
        )
        .returning({ operationId: schema.interactionResourceOperations.operationId });
      if (!completed) {
        throw new InteractionResourceConflictError(
          "External-auth settlement lost its operation fence",
        );
      }
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (
      postgresConstraint(error) === "interaction_interventions_workspace_operation_uq" ||
      postgresConstraint(error) === "interaction_interventions_open_target_kind_uq" ||
      postgresConstraint(error) === "interaction_interventions_open_auth_run_uq"
    ) {
      throw new InteractionResourceConflictError(
        "A matching interaction intervention is already open",
      );
    }
    throw error;
  }
}

function assertExternalAuthOperationBinding(
  operation: ResourceOperationRow,
  input: { authRunId: string; actorSubjectId: string },
): void {
  if (
    operation.resourceKind !== "auth_run" ||
    operation.resourceId !== input.authRunId ||
    operation.kind !== "external_auth" ||
    operation.actorSubjectId !== input.actorSubjectId
  ) {
    throw new InteractionResourceConflictError(
      "Operation id is bound to another external-auth request",
    );
  }
}

export async function prepareProtectedAuthFill(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
    credentialVersion: number | null;
  } & ProtectedAuthFillRequestValue,
): Promise<ProtectedAuthFillPreparation> {
  const request = parseProtectedAuthFillRequest(input);
  const digest = protectedAuthFillDigest(input.authRunId, request, input.actorSubjectId);
  return await withRlsContext(db, input, async (scopedDb) => {
    await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
    await setSubjectRlsContext(scopedDb, input.actorSubjectId);
    await lockOperation(scopedDb, request.operationId);
    const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
    if (existing) {
      assertOperationIdentity(existing, {
        resourceKind: "auth_run",
        resourceId: input.authRunId,
        kind: "protected_fill",
        requestDigest: digest,
        actorSubjectId: input.actorSubjectId,
      });
      const run = await loadAuthRunRow(scopedDb, input.workspaceId, input.authRunId);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      return protectedAuthPreparationFromOperation(existing, run);
    }

    const [run] = await scopedDb
      .select()
      .from(schema.authRuns)
      .where(
        and(
          eq(schema.authRuns.workspaceId, input.workspaceId),
          eq(schema.authRuns.id, input.authRunId),
        ),
      )
      .for("update")
      .limit(1);
    if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
    if (run.settledAt) throw new InteractionResourceStateError("Auth run is already settled");
    if (run.version !== request.expectedVersion) {
      throw new InteractionResourceConflictError("Auth run changed before protected fill");
    }
    if (
      run.targetGeneration !== request.expectedTargetGeneration ||
      run.documentGeneration !== request.expectedDocumentGeneration ||
      !request.expectedDocumentGeneration ||
      !request.expectedFrameId
    ) {
      throw new InteractionResourceConflictError(
        "Protected fill does not match the exact auth-run document",
      );
    }
    const [browser] = await scopedDb
      .select({
        lifecycle: schema.browserSessions.lifecycle,
        controllerGeneration: schema.browserSessions.controllerGeneration,
      })
      .from(schema.browserSessions)
      .where(
        and(
          eq(schema.browserSessions.workspaceId, input.workspaceId),
          eq(schema.browserSessions.id, run.browserSessionId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !browser ||
      browser.lifecycle !== "active" ||
      browser.controllerGeneration !== run.controllerGeneration
    ) {
      throw new InteractionResourceConflictError(
        "Protected fill belongs to a stale browser controller",
      );
    }
    const connectionRow = await getSiteAuthConnectionRow(
      scopedDb,
      input.workspaceId,
      run.siteAuthConnectionId,
    );
    if (connectionRow.status !== "active") {
      throw new InteractionResourceStateError("Site auth connection is archived");
    }
    const connection = siteAuthConnectionFromRow(connectionRow);
    assertAuthSelection(connection, {
      methodId: run.methodId,
      authorityId: request.authorityId,
    });
    if (run.authorityId && run.authorityId !== request.authorityId) {
      throw new InteractionResourceConflictError("Auth run selected another authority");
    }
    const authority = connection.authorities.find(
      (candidate) => candidate.id === request.authorityId,
    );
    if (!authority) throw new InteractionResourceStateError("Auth authority is not configured");
    const fields = protectedAuthFields(authority, request.fields);
    if (
      (authority.kind === "connection_fields" &&
        (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion! < 1)) ||
      (authority.kind !== "connection_fields" && input.credentialVersion !== null)
    ) {
      throw new InteractionResourceStateError("Protected-fill credential version is invalid");
    }
    const metadata: ProtectedAuthOperationMetadata = {
      schemaVersion: 1,
      authRunVersion: run.version,
      authority,
      origins: [...connection.origins],
      fields,
      credentialVersion: input.credentialVersion,
    };
    await scopedDb.insert(schema.interactionResourceOperations).values({
      operationId: request.operationId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      resourceKind: "auth_run",
      resourceId: input.authRunId,
      kind: "protected_fill",
      requestDigest: digest,
      metadata,
      state: "prepared",
      actorSubjectId: input.actorSubjectId,
    });
    return {
      run: authRunFromRow(run),
      authority,
      origins: [...connection.origins],
      credentialVersion: input.credentialVersion,
      operationState: "prepared",
      response: null,
      replayed: false,
    };
  });
}

export async function dispatchProtectedAuthFill(
  db: Database,
  input: InteractionMutationScope & { authRunId: string; operationId: string },
): Promise<ResourceOperationRow["state"]> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await lockOperation(scopedDb, input.operationId);
    const [operation] = await scopedDb
      .select()
      .from(schema.interactionResourceOperations)
      .where(
        and(
          eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
          eq(schema.interactionResourceOperations.operationId, input.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!operation)
      throw new InteractionResourceNotFoundError("Protected-fill operation not found");
    assertProtectedFillOperationBinding(operation, input);
    if (operation.state === "prepared") {
      const [dispatched] = await scopedDb
        .update(schema.interactionResourceOperations)
        .set({ state: "dispatched" })
        .where(
          and(
            eq(schema.interactionResourceOperations.operationId, input.operationId),
            eq(schema.interactionResourceOperations.state, "prepared"),
          ),
        )
        .returning({ state: schema.interactionResourceOperations.state });
      if (!dispatched) {
        throw new InteractionResourceConflictError("Protected-fill dispatch lost its fence");
      }
      return dispatched.state;
    }
    return operation.state;
  });
}

export async function completeProtectedAuthFill(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
    operationId: string;
    status: ProtectedAuthFillResponseValue["status"];
    targetGeneration?: string;
    documentGeneration?: string | null;
    failureCode?: string;
    intervention?: {
      originatingSessionId: string;
      originatingTurnId?: string | null;
      originatingAttemptId?: string | null;
      originatingToolOperationId?: string | null;
      kind: "manual_login" | "mfa" | "external_action" | "confirmation" | "other";
      reason: string;
      expiresInSeconds: number;
    };
  },
): Promise<ProtectedAuthFillResponseValue> {
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await lockOperation(scopedDb, input.operationId);
      const [operation] = await scopedDb
        .select()
        .from(schema.interactionResourceOperations)
        .where(
          and(
            eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
            eq(schema.interactionResourceOperations.operationId, input.operationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!operation)
        throw new InteractionResourceNotFoundError("Protected-fill operation not found");
      assertProtectedFillOperationBinding(operation, input);
      if (operation.state === "completed" && operation.result) {
        return {
          ...ProtectedAuthFillResponse.parse(operation.result),
          replayed: true,
        };
      }
      if (operation.state === "failed" || operation.state === "outcome_unknown") {
        throw new InteractionResourceStateError(
          `Protected-fill operation is ${operation.state.replace("_", " ")}`,
        );
      }
      if (
        (input.status === "submitted" || input.status === "working") &&
        operation.state !== "dispatched"
      ) {
        throw new InteractionResourceStateError("Protected fill was not dispatched");
      }
      const metadata = protectedAuthOperationMetadata(operation.metadata);
      const [run] = await scopedDb
        .select()
        .from(schema.authRuns)
        .where(
          and(
            eq(schema.authRuns.workspaceId, input.workspaceId),
            eq(schema.authRuns.id, input.authRunId),
          ),
        )
        .for("update")
        .limit(1);
      if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
      if (run.version !== metadata.authRunVersion || run.settledAt) {
        throw new InteractionResourceConflictError("Auth run changed after protected fill began");
      }
      if (input.targetGeneration && input.targetGeneration !== run.targetGeneration) {
        throw new InteractionResourceConflictError("Protected-fill result targets another tab");
      }
      const submitted = input.status === "submitted" || input.status === "working";
      const needsHuman = input.status === "needs_human";
      if (needsHuman !== Boolean(input.intervention)) {
        throw new InteractionResourceStateError(
          "Human protected fill requires one durable intervention",
        );
      }
      if (needsHuman && metadata.authority.kind !== "human") {
        throw new InteractionResourceStateError(
          "Only a human auth authority can request human intervention",
        );
      }
      let interventionId: string | null = null;
      if (needsHuman) {
        const intervention = input.intervention!;
        if (
          (intervention.originatingAttemptId && !intervention.originatingTurnId) ||
          (intervention.originatingToolOperationId && !intervention.originatingAttemptId)
        ) {
          throw new InteractionResourceStateError(
            "Protected-fill intervention provenance is incomplete",
          );
        }
        const request = CreateInteractionInterventionRequest.parse({
          operationId: input.operationId,
          resourceKind: "browser_session",
          resourceId: run.browserSessionId,
          targetId: run.targetId,
          expectedControllerGeneration: run.controllerGeneration,
          expectedTargetGeneration: run.targetGeneration,
          expectedDocumentGeneration: run.documentGeneration,
          kind: intervention.kind,
          reason: intervention.reason,
          authRunId: run.id,
          expiresInSeconds: intervention.expiresInSeconds,
        });
        interventionId = randomUUID();
        const [created] = await scopedDb
          .insert(schema.interactionInterventions)
          .values({
            id: interventionId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            resourceKind: request.resourceKind,
            resourceId: request.resourceId,
            targetId: request.targetId,
            controllerGeneration: request.expectedControllerGeneration,
            targetGeneration: request.expectedTargetGeneration,
            documentGeneration: request.expectedDocumentGeneration,
            kind: request.kind,
            reason: request.reason,
            authRunId: run.id,
            originatingSessionId: intervention.originatingSessionId,
            originatingTurnId: intervention.originatingTurnId ?? null,
            originatingAttemptId: intervention.originatingAttemptId ?? null,
            originatingToolOperationId: intervention.originatingToolOperationId ?? null,
            operationId: input.operationId,
            expiresAt: sql`now() + (${request.expiresInSeconds} * interval '1 second')`,
          })
          .returning({ id: schema.interactionInterventions.id });
        if (!created) {
          throw new Error("Protected-fill intervention insert returned no row");
        }
      }
      const failureCode =
        submitted || needsHuman ? null : (input.failureCode ?? "protected_fill_failed");
      const [updated] = await scopedDb
        .update(schema.authRuns)
        .set({
          authorityId: metadata.authority.id,
          state: submitted ? "working" : needsHuman ? "awaiting_secret" : "failed",
          choices: [],
          pendingFields: needsHuman
            ? metadata.fields.map((field) => ({
                id: field.id,
                label: field.id,
                purpose: field.purpose,
              }))
            : [],
          externalAction: null,
          interventionId,
          verifiedUrl: null,
          failureCode,
          documentGeneration:
            submitted && input.documentGeneration !== undefined
              ? input.documentGeneration
              : run.documentGeneration,
          version: run.version + 1,
          updatedAt: sql`now()`,
          settledAt: failureCode ? sql`now()` : null,
        })
        .where(
          and(
            eq(schema.authRuns.workspaceId, input.workspaceId),
            eq(schema.authRuns.id, input.authRunId),
            eq(schema.authRuns.version, metadata.authRunVersion),
            sql`${schema.authRuns.settledAt} is null`,
          ),
        )
        .returning();
      if (!updated) {
        throw new InteractionResourceConflictError("Protected-fill settlement lost its auth fence");
      }
      await projectSettledAuthRunHealth(scopedDb, {
        run: updated,
        actorSubjectId: input.actorSubjectId,
      });
      const response = ProtectedAuthFillResponse.parse({
        run: authRunFromRow(updated),
        status: input.status,
        operationId: input.operationId,
        replayed: false,
      });
      const [completed] = await scopedDb
        .update(schema.interactionResourceOperations)
        .set({
          state: "completed",
          resultVersion: updated.version,
          result: response,
          settledAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.interactionResourceOperations.operationId, input.operationId),
            inArray(schema.interactionResourceOperations.state, ["prepared", "dispatched"]),
          ),
        )
        .returning({
          operationId: schema.interactionResourceOperations.operationId,
        });
      if (!completed) {
        throw new InteractionResourceConflictError(
          "Protected-fill settlement lost its operation fence",
        );
      }
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (
      postgresConstraint(error) === "interaction_interventions_workspace_operation_uq" ||
      postgresConstraint(error) === "interaction_interventions_open_target_kind_uq" ||
      postgresConstraint(error) === "interaction_interventions_open_auth_run_uq"
    ) {
      throw new InteractionResourceConflictError(
        "A matching interaction intervention is already open",
      );
    }
    throw error;
  }
}

export async function markProtectedAuthFillOutcomeUnknown(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
    operationId: string;
    errorCode: string;
  },
): Promise<void> {
  await withRlsContext(db, input, async (scopedDb) => {
    await lockOperation(scopedDb, input.operationId);
    const [operation] = await scopedDb
      .select()
      .from(schema.interactionResourceOperations)
      .where(
        and(
          eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
          eq(schema.interactionResourceOperations.operationId, input.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!operation)
      throw new InteractionResourceNotFoundError("Protected-fill operation not found");
    assertProtectedFillOperationBinding(operation, input);
    if (
      operation.state === "completed" ||
      operation.state === "failed" ||
      operation.state === "outcome_unknown"
    ) {
      return;
    }
    const [marked] = await scopedDb
      .update(schema.interactionResourceOperations)
      .set({
        state: "outcome_unknown",
        errorCode: input.errorCode,
        settledAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.interactionResourceOperations.operationId, input.operationId),
          inArray(schema.interactionResourceOperations.state, ["prepared", "dispatched"]),
        ),
      )
      .returning({
        operationId: schema.interactionResourceOperations.operationId,
      });
    if (!marked) {
      throw new InteractionResourceConflictError(
        "Protected-fill unknown outcome lost its operation fence",
      );
    }
    const metadata = protectedAuthOperationMetadata(operation.metadata);
    const [failedRun] = await scopedDb
      .update(schema.authRuns)
      .set({
        state: "failed",
        choices: [],
        pendingFields: [],
        externalAction: null,
        verifiedUrl: null,
        failureCode: input.errorCode,
        version: sql`${schema.authRuns.version} + 1`,
        updatedAt: sql`now()`,
        settledAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.authRuns.workspaceId, input.workspaceId),
          eq(schema.authRuns.id, input.authRunId),
          eq(schema.authRuns.version, metadata.authRunVersion),
          sql`${schema.authRuns.settledAt} is null`,
        ),
      )
      .returning();
    if (failedRun) {
      await projectSettledAuthRunHealth(scopedDb, {
        run: failedRun,
        actorSubjectId: input.actorSubjectId,
      });
    }
    await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
  });
}

function assertProtectedFillOperationBinding(
  operation: ResourceOperationRow,
  input: { authRunId: string; actorSubjectId: string },
): void {
  if (
    operation.resourceKind !== "auth_run" ||
    operation.resourceId !== input.authRunId ||
    operation.kind !== "protected_fill" ||
    operation.actorSubjectId !== input.actorSubjectId
  ) {
    throw new InteractionResourceConflictError(
      "Operation id is bound to another protected-fill request",
    );
  }
}

export async function verifyAuthRun(
  db: Database,
  input: InteractionMutationScope & {
    authRunId: string;
    controllerGeneration: string;
    targetId: string;
    targetGeneration: string;
    documentGeneration: string | null;
    url: string;
  } & VerifyAuthRunRequestValue,
): Promise<AuthRunMutationResponseValue> {
  const request = VerifyAuthRunRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
  });
  const digest = operationDigest({
    version: 1,
    authRunId: input.authRunId,
    controllerGeneration: input.controllerGeneration,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
    documentGeneration: input.documentGeneration,
    url: input.url,
    expectedVersion: request.expectedVersion,
    actorSubjectId: input.actorSubjectId,
  });
  return await withRlsContext(db, input, async (scopedDb) => {
    await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
    await lockOperation(scopedDb, request.operationId);
    const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
    if (existing) {
      assertOperation(existing, {
        resourceKind: "auth_run",
        resourceId: input.authRunId,
        kind: "verify",
        requestDigest: digest,
        actorSubjectId: input.actorSubjectId,
      });
      return {
        ...AuthRunMutationResponse.parse(existing.result),
        replayed: true,
      };
    }
    const [run] = await scopedDb
      .select()
      .from(schema.authRuns)
      .where(
        and(
          eq(schema.authRuns.workspaceId, input.workspaceId),
          eq(schema.authRuns.id, input.authRunId),
        ),
      )
      .for("update")
      .limit(1);
    if (!run) throw new InteractionResourceNotFoundError("Auth run not found");
    if (run.version !== request.expectedVersion) {
      throw new InteractionResourceConflictError("Auth run changed before verification");
    }
    if (
      run.controllerGeneration !== input.controllerGeneration ||
      run.targetId !== input.targetId ||
      run.targetGeneration !== input.targetGeneration
    ) {
      throw new InteractionResourceConflictError("Verification targets another browser tab");
    }
    const connection = await getSiteAuthConnectionRow(
      scopedDb,
      input.workspaceId,
      run.siteAuthConnectionId,
    );
    const verified = connection.verificationUrlPrefixes.some((prefix) =>
      input.url.startsWith(prefix),
    );
    let resultRun = run;
    if (verified) {
      if (run.settledAt && run.state !== "verified") {
        throw new InteractionResourceStateError("Auth run is already settled");
      }
      if (!run.settledAt) {
        const [updated] = await scopedDb
          .update(schema.authRuns)
          .set({
            state: "verified",
            choices: [],
            pendingFields: [],
            externalAction: null,
            interventionId: null,
            documentGeneration: input.documentGeneration,
            verifiedUrl: input.url,
            failureCode: null,
            version: run.version + 1,
            updatedAt: sql`now()`,
            settledAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.authRuns.workspaceId, input.workspaceId),
              eq(schema.authRuns.id, input.authRunId),
              eq(schema.authRuns.version, request.expectedVersion),
            ),
          )
          .returning();
        if (!updated)
          throw new InteractionResourceConflictError("Auth verification lost its fence");
        resultRun = updated;
        await projectSettledAuthRunHealth(scopedDb, {
          run: updated,
          actorSubjectId: input.actorSubjectId,
        });
      }
    }
    const response = AuthRunMutationResponse.parse({
      run: authRunFromRow(resultRun),
      operationId: request.operationId,
      replayed: false,
    });
    await insertCompletedOperation(scopedDb, {
      operationId: request.operationId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      resourceKind: "auth_run",
      resourceId: input.authRunId,
      kind: "verify",
      requestDigest: digest,
      resultVersion: resultRun.version,
      result: response,
      actorSubjectId: input.actorSubjectId,
    });
    if (verified && !run.settledAt) {
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
    }
    return response;
  });
}

async function getSiteAuthConnectionRow(
  db: Database,
  workspaceId: string,
  siteAuthConnectionId: string,
): Promise<SiteAuthConnectionRow> {
  const [row] = await db
    .select()
    .from(schema.siteAuthConnections)
    .where(
      and(
        eq(schema.siteAuthConnections.workspaceId, workspaceId),
        eq(schema.siteAuthConnections.id, siteAuthConnectionId),
      ),
    )
    .limit(1);
  if (!row) throw new InteractionResourceNotFoundError("Site auth connection not found");
  return row;
}

function interventionFromRow(row: InterventionRow): InteractionInterventionValue {
  return InteractionIntervention.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    targetId: row.targetId,
    controllerGeneration: row.controllerGeneration,
    targetGeneration: row.targetGeneration,
    documentGeneration: row.documentGeneration,
    kind: row.kind,
    reason: row.reason,
    status: row.status,
    authRunId: row.authRunId,
    originatingSessionId: row.originatingSessionId,
    originatingTurnId: row.originatingTurnId,
    originatingAttemptId: row.originatingAttemptId,
    originatingToolOperationId: row.originatingToolOperationId,
    responseActorSubjectId: row.responseActorSubjectId,
    version: row.version,
    operationId: row.operationId,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    settledAt: row.settledAt ? iso(row.settledAt) : null,
  });
}

async function loadInterventionRow(
  db: Database,
  workspaceId: string,
  interventionId: string,
): Promise<InterventionRow | null> {
  const [row] = await db
    .select()
    .from(schema.interactionInterventions)
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, workspaceId),
        eq(schema.interactionInterventions.id, interventionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function assertActiveInteractionResource(
  db: Database,
  input: {
    workspaceId: string;
    resourceKind: "browser_session" | "computer_session";
    resourceId: string;
    expectedControllerGeneration: string;
  },
): Promise<void> {
  if (input.resourceKind === "browser_session") {
    const [resource] = await db
      .select({
        lifecycle: schema.browserSessions.lifecycle,
        controllerGeneration: schema.browserSessions.controllerGeneration,
      })
      .from(schema.browserSessions)
      .where(
        and(
          eq(schema.browserSessions.workspaceId, input.workspaceId),
          eq(schema.browserSessions.id, input.resourceId),
        ),
      )
      .for("update")
      .limit(1);
    if (!resource) throw new InteractionResourceNotFoundError("Browser session not found");
    if (resource.lifecycle !== "active" || !resource.controllerGeneration) {
      throw new InteractionResourceStateError("Browser session is not active");
    }
    if (resource.controllerGeneration !== input.expectedControllerGeneration) {
      throw new InteractionResourceConflictError(
        "Browser intervention belongs to a stale controller",
      );
    }
    return;
  }
  const [resource] = await db
    .select({
      lifecycle: schema.computerSessions.lifecycle,
      controllerGeneration: schema.computerSessions.controllerGeneration,
    })
    .from(schema.computerSessions)
    .where(
      and(
        eq(schema.computerSessions.workspaceId, input.workspaceId),
        eq(schema.computerSessions.id, input.resourceId),
      ),
    )
    .for("update")
    .limit(1);
  if (!resource) throw new InteractionResourceNotFoundError("Computer session not found");
  if (resource.lifecycle !== "active" || !resource.controllerGeneration) {
    throw new InteractionResourceStateError("Computer session is not active");
  }
  if (resource.controllerGeneration !== input.expectedControllerGeneration) {
    throw new InteractionResourceConflictError(
      "Computer intervention belongs to a stale controller",
    );
  }
}

async function settleLinkedAuthRun(
  db: Database,
  input: {
    workspaceId: string;
    authRunId: string | null;
    interventionId: string;
    outcome: "completed" | "dismissed" | "expired" | "cancelled";
  },
): Promise<void> {
  if (!input.authRunId) return;
  const [run] = await db
    .select()
    .from(schema.authRuns)
    .where(
      and(
        eq(schema.authRuns.workspaceId, input.workspaceId),
        eq(schema.authRuns.id, input.authRunId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run || run.interventionId !== input.interventionId || run.settledAt) return;
  const resumed = input.outcome === "completed";
  const [settled] = await db
    .update(schema.authRuns)
    .set({
      state: resumed ? "working" : input.outcome === "cancelled" ? "cancelled" : "failed",
      choices: [],
      pendingFields: [],
      externalAction: null,
      interventionId: null,
      failureCode:
        resumed || input.outcome === "cancelled" ? null : `intervention_${input.outcome}`,
      version: run.version + 1,
      updatedAt: sql`now()`,
      settledAt: resumed ? null : sql`now()`,
    })
    .where(
      and(
        eq(schema.authRuns.workspaceId, input.workspaceId),
        eq(schema.authRuns.id, input.authRunId),
        eq(schema.authRuns.version, run.version),
        eq(schema.authRuns.interventionId, input.interventionId),
      ),
    )
    .returning();
  if (!settled) {
    throw new InteractionResourceConflictError(
      "Linked auth run changed before intervention settlement",
    );
  }
  await projectSettledAuthRunHealth(db, {
    run: settled,
    actorSubjectId: run.createdBySubjectId,
  });
}

async function expireInterventionsInScope(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<number> {
  const expired = await db
    .update(schema.interactionInterventions)
    .set({
      status: "expired",
      version: sql`${schema.interactionInterventions.version} + 1`,
      updatedAt: sql`now()`,
      settledAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, input.workspaceId),
        eq(schema.interactionInterventions.status, "open"),
        // Model-owned interventions are also pending approvals. Only the
        // owning session workflow may expire those rows, because it must append
        // the exact rejection that resumes the frozen RunState atomically.
        sql`${schema.interactionInterventions.originatingToolCallId} is null`,
        sql`${schema.interactionInterventions.expiresAt} <= now()`,
      ),
    )
    .returning({
      id: schema.interactionInterventions.id,
      authRunId: schema.interactionInterventions.authRunId,
    });
  for (const intervention of expired) {
    await settleLinkedAuthRun(db, {
      workspaceId: input.workspaceId,
      authRunId: intervention.authRunId,
      interventionId: intervention.id,
      outcome: "expired",
    });
  }
  if (expired.length > 0) {
    await advanceWorkspaceInteractionRevision(db, input.accountId, input.workspaceId);
  }
  return expired.length;
}

export async function listInteractionInterventions(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    resourceKind?: "browser_session" | "computer_session";
    resourceId?: string;
    includeSettled?: boolean;
  },
): Promise<InteractionInterventionListResponseValue> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await expireInterventionsInScope(scopedDb, input);
    const predicates = [eq(schema.interactionInterventions.workspaceId, input.workspaceId)];
    if (input.resourceKind) {
      predicates.push(eq(schema.interactionInterventions.resourceKind, input.resourceKind));
    }
    if (input.resourceId) {
      predicates.push(eq(schema.interactionInterventions.resourceId, input.resourceId));
    }
    if (!input.includeSettled) {
      predicates.push(eq(schema.interactionInterventions.status, "open"));
    }
    const interventions = await scopedDb
      .select()
      .from(schema.interactionInterventions)
      .where(and(...predicates))
      .orderBy(
        asc(schema.interactionInterventions.createdAt),
        asc(schema.interactionInterventions.id),
      );
    return InteractionInterventionListResponse.parse({
      interventions: interventions.map(interventionFromRow),
    });
  });
}

export async function getInteractionIntervention(
  db: Database,
  input: { accountId: string; workspaceId: string; interventionId: string },
): Promise<InteractionInterventionValue> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await expireInterventionsInScope(scopedDb, input);
    const row = await loadInterventionRow(scopedDb, input.workspaceId, input.interventionId);
    if (!row) throw new InteractionResourceNotFoundError("Interaction intervention not found");
    return interventionFromRow(row);
  });
}

export type AttemptInteractionInterventionRequest = {
  id: string;
  operationId: string;
  accountId: string;
  workspaceId: string;
  originatingSessionId: string;
  originatingTurnId: string;
  originatingAttemptId: string;
  toolCallId: string;
  input: RequestHumanInteractionToolInputValue;
};

/**
 * Persist one interaction interruption inside the same transaction as its
 * frozen Agent RunState. This is deliberately transaction-local: callers must
 * already hold the session/turn/attempt settlement locks and RLS context.
 */
export async function persistAttemptInteractionInterventionInTransaction(
  db: Database,
  raw: AttemptInteractionInterventionRequest,
): Promise<InteractionInterventionValue> {
  const input = RequestHumanInteractionToolInput.parse(raw.input);
  if (Buffer.byteLength(raw.toolCallId) < 1 || Buffer.byteLength(raw.toolCallId) > 1_024) {
    throw new InteractionResourceStateError("Interaction tool call id is invalid");
  }
  if (input.operation === "wait") {
    const [current] = await db
      .select()
      .from(schema.interactionInterventions)
      .where(
        and(
          eq(schema.interactionInterventions.workspaceId, raw.workspaceId),
          eq(schema.interactionInterventions.id, input.interventionId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw new InteractionResourceNotFoundError("Interaction intervention not found");
    if (current.status !== "open" || current.expiresAt.getTime() <= Date.now()) {
      throw new InteractionResourceStateError("Interaction intervention is no longer open");
    }
    if (
      current.originatingSessionId !== raw.originatingSessionId ||
      current.originatingTurnId !== raw.originatingTurnId
    ) {
      throw new InteractionResourceConflictError(
        "Interaction intervention belongs to another agent operation",
      );
    }
    if (
      current.originatingToolCallId !== null &&
      current.originatingToolCallId !== raw.toolCallId
    ) {
      throw new InteractionResourceConflictError(
        "Interaction intervention already has another waiting tool call",
      );
    }
    const row =
      current.originatingToolCallId === raw.toolCallId
        ? current
        : (
            await db
              .update(schema.interactionInterventions)
              .set({
                originatingToolCallId: raw.toolCallId,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(schema.interactionInterventions.workspaceId, raw.workspaceId),
                  eq(schema.interactionInterventions.id, current.id),
                  eq(schema.interactionInterventions.version, current.version),
                  eq(schema.interactionInterventions.status, "open"),
                  sql`${schema.interactionInterventions.originatingToolCallId} is null`,
                ),
              )
              .returning()
          )[0];
    if (!row) throw new InteractionResourceConflictError("Intervention wait lost its fence");
    return interventionFromRow(row);
  }

  await assertActiveInteractionResource(db, {
    workspaceId: raw.workspaceId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    expectedControllerGeneration: input.expectedControllerGeneration,
  });
  let authRun: AuthRunRow | null = null;
  if (input.authRunId) {
    if (input.resourceKind !== "browser_session") {
      throw new InteractionResourceStateError("Only browser interventions can belong to auth runs");
    }
    authRun = await loadAuthRunRow(db, raw.workspaceId, input.authRunId);
    if (!authRun) throw new InteractionResourceNotFoundError("Auth run not found");
    if (
      authRun.browserSessionId !== input.resourceId ||
      authRun.targetId !== input.targetId ||
      authRun.controllerGeneration !== input.expectedControllerGeneration ||
      authRun.targetGeneration !== input.expectedTargetGeneration ||
      authRun.documentGeneration !== input.expectedDocumentGeneration ||
      authRun.settledAt
    ) {
      throw new InteractionResourceConflictError(
        "Interaction intervention does not match the active auth run",
      );
    }
  }
  const [existing] = await db
    .select()
    .from(schema.interactionInterventions)
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, raw.workspaceId),
        eq(schema.interactionInterventions.id, raw.id),
      ),
    )
    .for("update")
    .limit(1);
  if (existing) {
    if (
      existing.operationId !== raw.operationId ||
      existing.originatingSessionId !== raw.originatingSessionId ||
      existing.originatingTurnId !== raw.originatingTurnId ||
      existing.originatingToolCallId !== raw.toolCallId ||
      existing.resourceKind !== input.resourceKind ||
      existing.resourceId !== input.resourceId ||
      existing.targetId !== input.targetId ||
      existing.controllerGeneration !== input.expectedControllerGeneration ||
      existing.targetGeneration !== input.expectedTargetGeneration ||
      existing.documentGeneration !== input.expectedDocumentGeneration ||
      existing.kind !== input.kind ||
      existing.reason !== input.reason ||
      existing.authRunId !== (input.authRunId ?? null) ||
      existing.status !== "open"
    ) {
      throw new InteractionResourceConflictError("Interaction interruption replay changed");
    }
    return interventionFromRow(existing);
  }
  const [row] = await db
    .insert(schema.interactionInterventions)
    .values({
      id: raw.id,
      accountId: raw.accountId,
      workspaceId: raw.workspaceId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      targetId: input.targetId,
      controllerGeneration: input.expectedControllerGeneration,
      targetGeneration: input.expectedTargetGeneration,
      documentGeneration: input.expectedDocumentGeneration,
      kind: input.kind,
      reason: input.reason,
      authRunId: input.authRunId ?? null,
      originatingSessionId: raw.originatingSessionId,
      originatingTurnId: raw.originatingTurnId,
      originatingAttemptId: raw.originatingAttemptId,
      originatingToolOperationId: raw.operationId,
      originatingToolCallId: raw.toolCallId,
      operationId: raw.operationId,
      expiresAt: sql`now() + (${input.expiresInSeconds} * interval '1 second')`,
    })
    .returning();
  if (!row) throw new Error("Interaction interruption insert returned no row");
  if (authRun) {
    const linked = await db
      .update(schema.authRuns)
      .set({
        interventionId: row.id,
        version: authRun.version + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.authRuns.workspaceId, raw.workspaceId),
          eq(schema.authRuns.id, authRun.id),
          eq(schema.authRuns.version, authRun.version),
          sql`${schema.authRuns.settledAt} is null`,
        ),
      )
      .returning({ id: schema.authRuns.id });
    if (linked.length !== 1) {
      throw new InteractionResourceConflictError("Auth run changed before intervention link");
    }
  }
  await advanceWorkspaceInteractionRevision(db, raw.accountId, raw.workspaceId);
  return interventionFromRow(row);
}

export async function getInteractionInterventionApprovalTarget(
  db: Database,
  input: { accountId: string; workspaceId: string; interventionId: string },
): Promise<{ sessionId: string; toolCallId: string } | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const row = await loadInterventionRow(scopedDb, input.workspaceId, input.interventionId);
    return row?.originatingToolCallId
      ? {
          sessionId: row.originatingSessionId,
          toolCallId: row.originatingToolCallId,
        }
      : null;
  });
}

export async function getInteractionInterventionResumeForEvent(
  db: Database,
  workspaceId: string,
  sessionId: string,
  event: Pick<SessionEvent, "type" | "payload">,
): Promise<{
  toolCallId: string;
  intervention: InteractionInterventionValue;
} | null> {
  if (event.type !== "user.approvalDecision") return null;
  const payload = event.payload as { approvalId?: unknown; decision?: unknown };
  if (typeof payload.approvalId !== "string" || payload.decision !== "approve") return null;
  const [row] = await db
    .select()
    .from(schema.interactionInterventions)
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, workspaceId),
        eq(schema.interactionInterventions.originatingSessionId, sessionId),
        eq(schema.interactionInterventions.originatingToolCallId, payload.approvalId),
      ),
    )
    .orderBy(asc(schema.interactionInterventions.createdAt))
    .limit(1);
  if (!row || row.status !== "completed") return null;
  return {
    toolCallId: payload.approvalId,
    intervention: interventionFromRow(row),
  };
}

export async function createInteractionIntervention(
  db: Database,
  input: InteractionMutationScope &
    CreateInteractionInterventionRequestValue & {
      originatingSessionId: string;
      originatingTurnId?: string | null;
      originatingAttemptId?: string | null;
      originatingToolOperationId?: string | null;
    },
): Promise<InteractionInterventionMutationResponseValue> {
  const request = CreateInteractionInterventionRequest.parse({
    operationId: input.operationId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    targetId: input.targetId,
    expectedControllerGeneration: input.expectedControllerGeneration,
    expectedTargetGeneration: input.expectedTargetGeneration,
    expectedDocumentGeneration: input.expectedDocumentGeneration,
    kind: input.kind,
    reason: input.reason,
    ...(input.authRunId !== undefined ? { authRunId: input.authRunId } : {}),
    expiresInSeconds: input.expiresInSeconds,
  });
  const { operationId: _operationId, ...digestRequest } = request;
  const digest = operationDigest({
    version: 1,
    request: digestRequest,
    originatingSessionId: input.originatingSessionId,
    originatingTurnId: input.originatingTurnId ?? null,
    originatingAttemptId: input.originatingAttemptId ?? null,
    originatingToolOperationId: input.originatingToolOperationId ?? null,
    actorSubjectId: input.actorSubjectId,
  });
  try {
    return await withRlsContext(db, input, async (scopedDb) => {
      await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
      await lockOperation(scopedDb, request.operationId);
      const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
      if (existing) {
        assertOperation(existing, {
          resourceKind: "intervention",
          kind: "create",
          requestDigest: digest,
          actorSubjectId: input.actorSubjectId,
        });
        const response = InteractionInterventionMutationResponse.parse(existing.result);
        return { ...response, replayed: true };
      }
      await expireInterventionsInScope(scopedDb, input);
      await assertActiveInteractionResource(scopedDb, {
        workspaceId: input.workspaceId,
        resourceKind: request.resourceKind,
        resourceId: request.resourceId,
        expectedControllerGeneration: request.expectedControllerGeneration,
      });
      let authRun: AuthRunRow | null = null;
      if (request.authRunId) {
        if (request.resourceKind !== "browser_session") {
          throw new InteractionResourceStateError(
            "Only browser interventions can belong to an auth run",
          );
        }
        authRun = await loadAuthRunRow(scopedDb, input.workspaceId, request.authRunId);
        if (!authRun) throw new InteractionResourceNotFoundError("Auth run not found");
        if (
          authRun.browserSessionId !== request.resourceId ||
          authRun.targetId !== request.targetId ||
          authRun.controllerGeneration !== request.expectedControllerGeneration ||
          authRun.targetGeneration !== request.expectedTargetGeneration ||
          authRun.documentGeneration !== request.expectedDocumentGeneration
        ) {
          throw new InteractionResourceConflictError(
            "Intervention does not match the exact auth-run target",
          );
        }
        if (authRun.settledAt) {
          throw new InteractionResourceStateError("Auth run is already settled");
        }
      }
      const id = randomUUID();
      const [row] = await scopedDb
        .insert(schema.interactionInterventions)
        .values({
          id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          resourceKind: request.resourceKind,
          resourceId: request.resourceId,
          targetId: request.targetId,
          controllerGeneration: request.expectedControllerGeneration,
          targetGeneration: request.expectedTargetGeneration,
          documentGeneration: request.expectedDocumentGeneration,
          kind: request.kind,
          reason: request.reason,
          authRunId: request.authRunId ?? null,
          originatingSessionId: input.originatingSessionId,
          originatingTurnId: input.originatingTurnId ?? null,
          originatingAttemptId: input.originatingAttemptId ?? null,
          originatingToolOperationId: input.originatingToolOperationId ?? null,
          operationId: request.operationId,
          expiresAt: sql`now() + (${request.expiresInSeconds} * interval '1 second')`,
        })
        .returning();
      if (!row) throw new Error("Interaction intervention insert returned no row");
      if (authRun) {
        const linked = await scopedDb
          .update(schema.authRuns)
          .set({
            interventionId: id,
            version: authRun.version + 1,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.authRuns.workspaceId, input.workspaceId),
              eq(schema.authRuns.id, authRun.id),
              eq(schema.authRuns.version, authRun.version),
              sql`${schema.authRuns.settledAt} is null`,
            ),
          )
          .returning({ id: schema.authRuns.id });
        if (linked.length !== 1) {
          throw new InteractionResourceConflictError("Auth run changed before intervention link");
        }
      }
      const response = InteractionInterventionMutationResponse.parse({
        intervention: interventionFromRow(row),
        operationId: request.operationId,
        replayed: false,
      });
      await insertCompletedOperation(scopedDb, {
        operationId: request.operationId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        resourceKind: "intervention",
        resourceId: id,
        kind: "create",
        requestDigest: digest,
        resultVersion: row.version,
        result: response,
        actorSubjectId: input.actorSubjectId,
      });
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
      return response;
    });
  } catch (error) {
    if (
      postgresConstraint(error) === "interaction_interventions_open_target_kind_uq" ||
      postgresConstraint(error) === "interaction_interventions_open_auth_run_uq"
    ) {
      throw new InteractionResourceConflictError(
        "A matching interaction intervention is already open",
      );
    }
    throw error;
  }
}

export async function resolveInteractionInterventionInTransaction(
  db: Database,
  input: InteractionMutationScope & {
    interventionId: string;
  } & ResolveInteractionInterventionRequestValue,
): Promise<InteractionInterventionMutationResponseValue> {
  const request = ResolveInteractionInterventionRequest.parse({
    operationId: input.operationId,
    expectedVersion: input.expectedVersion,
    outcome: input.outcome,
  });
  const { operationId: _operationId, ...digestRequest } = request;
  const digest = operationDigest({
    version: 1,
    interventionId: input.interventionId,
    request: digestRequest,
    actorSubjectId: input.actorSubjectId,
  });
  const scopedDb = db;
  await assertWorkspaceAccount(scopedDb, input.accountId, input.workspaceId);
  await lockOperation(scopedDb, request.operationId);
  const existing = await loadOperation(scopedDb, input.workspaceId, request.operationId);
  if (existing) {
    assertOperation(existing, {
      resourceKind: "intervention",
      resourceId: input.interventionId,
      kind: "resolve",
      requestDigest: digest,
      actorSubjectId: input.actorSubjectId,
    });
    const response = InteractionInterventionMutationResponse.parse(existing.result);
    return { ...response, replayed: true };
  }
  const [current] = await scopedDb
    .select()
    .from(schema.interactionInterventions)
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, input.workspaceId),
        eq(schema.interactionInterventions.id, input.interventionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!current) {
    throw new InteractionResourceNotFoundError("Interaction intervention not found");
  }
  if (current.version !== request.expectedVersion) {
    throw new InteractionResourceConflictError(
      "Interaction intervention changed before this response",
    );
  }
  if (current.status !== "open") {
    throw new InteractionResourceStateError("Interaction intervention is already settled");
  }
  const expired = current.expiresAt.getTime() <= Date.now();
  const status = expired ? "expired" : request.outcome;
  const [row] = await scopedDb
    .update(schema.interactionInterventions)
    .set({
      status,
      responseActorSubjectId: expired ? null : input.actorSubjectId,
      version: current.version + 1,
      updatedAt: sql`now()`,
      settledAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, input.workspaceId),
        eq(schema.interactionInterventions.id, input.interventionId),
        eq(schema.interactionInterventions.version, request.expectedVersion),
        eq(schema.interactionInterventions.status, "open"),
      ),
    )
    .returning();
  if (!row) {
    throw new InteractionResourceConflictError("Intervention response lost its fence");
  }
  await settleLinkedAuthRun(scopedDb, {
    workspaceId: input.workspaceId,
    authRunId: row.authRunId,
    interventionId: row.id,
    outcome: status,
  });
  const response = InteractionInterventionMutationResponse.parse({
    intervention: interventionFromRow(row),
    operationId: request.operationId,
    replayed: false,
  });
  await insertCompletedOperation(scopedDb, {
    operationId: request.operationId,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    resourceKind: "intervention",
    resourceId: input.interventionId,
    kind: "resolve",
    requestDigest: digest,
    resultVersion: row.version,
    result: response,
    actorSubjectId: input.actorSubjectId,
  });
  await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
  return response;
}

export async function resolveInteractionIntervention(
  db: Database,
  input: InteractionMutationScope & {
    interventionId: string;
  } & ResolveInteractionInterventionRequestValue,
): Promise<InteractionInterventionMutationResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => await resolveInteractionInterventionInTransaction(scopedDb, input),
  );
}

/**
 * Cancel every still-open intervention created by a logical agent turn when
 * that turn becomes terminal. The caller already owns the turn-settlement
 * transaction, so no resource can outlive the terminal session truth.
 */
export async function cancelTurnInteractionInterventionsInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
  },
): Promise<number> {
  const cancelled = await db
    .update(schema.interactionInterventions)
    .set({
      status: "cancelled",
      version: sql`${schema.interactionInterventions.version} + 1`,
      updatedAt: sql`now()`,
      settledAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.interactionInterventions.workspaceId, input.workspaceId),
        eq(schema.interactionInterventions.originatingSessionId, input.sessionId),
        eq(schema.interactionInterventions.originatingTurnId, input.turnId),
        eq(schema.interactionInterventions.status, "open"),
      ),
    )
    .returning({
      id: schema.interactionInterventions.id,
      authRunId: schema.interactionInterventions.authRunId,
    });
  for (const intervention of cancelled) {
    await settleLinkedAuthRun(db, {
      workspaceId: input.workspaceId,
      authRunId: intervention.authRunId,
      interventionId: intervention.id,
      outcome: "cancelled",
    });
  }
  if (cancelled.length > 0) {
    await advanceWorkspaceInteractionRevision(db, input.accountId, input.workspaceId);
  }
  return cancelled.length;
}

export async function cancelOpenInteractionInterventions(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    resourceKind: "browser_session" | "computer_session";
    resourceId: string;
  },
): Promise<number> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const cancelled = await scopedDb
      .update(schema.interactionInterventions)
      .set({
        status: "cancelled",
        version: sql`${schema.interactionInterventions.version} + 1`,
        updatedAt: sql`now()`,
        settledAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.interactionInterventions.workspaceId, input.workspaceId),
          eq(schema.interactionInterventions.resourceKind, input.resourceKind),
          eq(schema.interactionInterventions.resourceId, input.resourceId),
          eq(schema.interactionInterventions.status, "open"),
        ),
      )
      .returning({
        id: schema.interactionInterventions.id,
        authRunId: schema.interactionInterventions.authRunId,
      });
    for (const intervention of cancelled) {
      await settleLinkedAuthRun(scopedDb, {
        workspaceId: input.workspaceId,
        authRunId: intervention.authRunId,
        interventionId: intervention.id,
        outcome: "cancelled",
      });
    }
    if (cancelled.length > 0) {
      await advanceWorkspaceInteractionRevision(scopedDb, input.accountId, input.workspaceId);
    }
    return cancelled.length;
  });
}
