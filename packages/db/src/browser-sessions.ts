import { createHash, randomUUID } from "node:crypto";
import {
  BrowserSession,
  BrowserSessionCapabilities,
  BrowserSessionListResponse,
  BrowserSessionMutationResponse,
  BrowserRevisionMaterialization,
  InteractionControllerBinding,
  InteractionError,
  InteractionLifecycleOperationReceipt,
  type BrowserSessionCapabilities as BrowserSessionCapabilitiesValue,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
  type BrowserSessionListResponse as BrowserSessionListResponseValue,
  type BrowserSessionMutationResponse as BrowserSessionMutationResponseValue,
  type InteractionError as InteractionErrorValue,
  type InteractionLifecycleOperationKind,
  type InteractionLifecycleOperationReceipt as InteractionLifecycleOperationReceiptValue,
  type InteractionPlacement,
  NetworkRouteConfiguration,
  NetworkRouteConsistency,
  type NetworkRouteConfiguration as NetworkRouteConfigurationValue,
  type NetworkRouteConsistency as NetworkRouteConsistencyValue,
} from "@opengeni/contracts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import { safeDatabaseErrorFacts } from "./persistence-errors";
import {
  validateBrowserStateArtifactCommitInput,
  type BrowserStateArtifactCommitInput,
} from "./browser-state-artifacts";
import * as schema from "./schema";

type BrowserSessionRow = typeof schema.browserSessions.$inferSelect;
type BrowserAssociationRow = typeof schema.browserSessionAssociations.$inferSelect;
type InteractionOperationRow = typeof schema.interactionOperations.$inferSelect;

const CONSISTENT_READ = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

export const MANAGED_BROWSER_SESSION_CAPABILITIES = BrowserSessionCapabilities.parse({
  semanticObservation: true,
  screenshots: true,
  liveFrames: true,
  humanInput: true,
  tabs: true,
  downloads: true,
  uploads: true,
  clipboard: true,
  permissions: true,
  diagnostics: true,
  rawCdp: false,
  linkedComputer: false,
  privateCheckpoint: true,
  identityPublication: true,
  parallelTargets: true,
});

export const ATTACHED_BROWSER_SESSION_CAPABILITIES = BrowserSessionCapabilities.parse({
  semanticObservation: true,
  screenshots: true,
  liveFrames: true,
  humanInput: true,
  tabs: true,
  downloads: false,
  uploads: false,
  clipboard: true,
  permissions: false,
  diagnostics: true,
  rawCdp: false,
  linkedComputer: false,
  privateCheckpoint: false,
  identityPublication: false,
  parallelTargets: true,
});

export class BrowserSessionNotFoundError extends Error {
  readonly name = "BrowserSessionNotFoundError";
}

export class BrowserSessionOperationConflictError extends Error {
  readonly name = "BrowserSessionOperationConflictError";
}

export class BrowserSessionStateError extends Error {
  readonly name = "BrowserSessionStateError";
}

export type PrepareBrowserSessionCreateInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  associatedSessionId: string;
  actorSubjectId: string;
  name: string;
  initialUrl: string | null;
  placement: InteractionPlacement;
  driverId: string;
  engine: BrowserSessionRow["engine"];
  headless: boolean;
  identityId: string | null;
  baseRevisionId: string | null;
  networkRouteId?: string | null;
  linkedComputerSessionId?: string | null;
  resolveDefaultRevision?: boolean;
  capabilities?: BrowserSessionCapabilitiesValue;
};

export type PrepareBrowserSessionEndInput = {
  accountId: string;
  workspaceId: string;
  browserSessionId: string;
  operationId: string;
  actorSubjectId: string;
};

export type PrepareBrowserSessionLifecycleInput = PrepareBrowserSessionEndInput;

export type BrowserPrivateCheckpointAuthority = {
  artifactId: string;
  sourceBrowserSessionId: string;
  objectKey: string;
  encryptedDataKey: string;
  format: string;
  artifactDigest: string;
  contentDigest: string;
  manifestDigest: string;
  sizeBytes: number;
  materialization: BrowserRevisionMaterializationValue;
};

/** Internal executor view of one BrowserSession. Plaintext controller
 * credentials are deliberately absent; callers derive them from this fenced
 * durable state. */
export type BrowserSessionControlRecord = {
  session: BrowserSession;
  tokenGeneration: number;
  sourceSessionId: string;
  createOperationId: string;
  networkRouteAuthority: BrowserSessionNetworkRouteAuthority | null;
  operation: null | {
    operationId: string;
    kind: InteractionLifecycleOperationKind;
    state: InteractionOperationRow["state"];
    controllerGeneration: string | null;
    actorSubjectId: string;
  };
};

export type BrowserSessionNetworkRouteAuthority = {
  routeId: string;
  routeVersion: number;
  credentialVersion: number | null;
  authorityDigest: string | null;
  configuration: NetworkRouteConfigurationValue;
  consistency: NetworkRouteConsistencyValue;
};

function iso(value: Date): string {
  return value.toISOString();
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is outside safe range`);
  return value;
}

function placementFromRow(row: BrowserSessionRow): InteractionPlacement {
  switch (row.placementKind) {
    case "sandbox_group":
      if (!row.sandboxGroupId) throw new Error("BrowserSession sandbox placement is incomplete");
      return { kind: "sandbox_group", sandboxGroupId: row.sandboxGroupId };
    case "connected_machine":
      if (!row.connectedSandboxId) {
        throw new Error("BrowserSession connected-machine placement is incomplete");
      }
      return { kind: "connected_machine", sandboxId: row.connectedSandboxId };
    case "attached_device":
      if (!row.deviceId) throw new Error("BrowserSession attached-device placement is incomplete");
      return { kind: "attached_device", deviceId: row.deviceId };
    case "external_provider":
      if (!row.externalProviderId || !row.externalPlacementId) {
        throw new Error("BrowserSession external placement is incomplete");
      }
      return {
        kind: "external_provider",
        providerId: row.externalProviderId,
        placementId: row.externalPlacementId,
      };
  }
}

function controllerFromRow(row: BrowserSessionRow): InteractionControllerBinding | null {
  if (!row.controllerId && !row.controllerGeneration && !row.placementInstanceId) return null;
  if (!row.controllerId || !row.controllerGeneration || !row.placementInstanceId) {
    throw new Error("BrowserSession controller binding is incomplete");
  }
  return {
    controllerId: row.controllerId,
    controllerGeneration: row.controllerGeneration,
    placementInstanceId: row.placementInstanceId,
  };
}

function associationFromRow(row: BrowserAssociationRow) {
  return {
    sessionId: row.sessionId,
    turnId: row.turnId,
    attemptId: row.attemptId,
    relationship: row.relationship,
    actorSubjectId: row.actorSubjectId,
    lastUsedAt: iso(row.lastUsedAt),
  } as const;
}

function browserSessionFromRows(
  row: BrowserSessionRow,
  associations: readonly BrowserAssociationRow[],
) {
  return BrowserSession.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    lifecycle: row.lifecycle,
    placement: placementFromRow(row),
    controller: controllerFromRow(row),
    driverId: row.driverId,
    engine: row.engine,
    engineVersion: row.engineVersion,
    headless: row.headless,
    identityId: row.identityId,
    baseRevisionId: row.baseRevisionId,
    networkRouteId: row.networkRouteId,
    linkedComputerSessionId: row.linkedComputerSessionId,
    capabilities: row.capabilities,
    associations: associations.map(associationFromRow),
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    lastUsedAt: iso(row.lastUsedAt),
    failureCode: row.failureCode,
  });
}

function operationReceipt(
  row: InteractionOperationRow,
  replayed: boolean,
): InteractionLifecycleOperationReceiptValue {
  const error: InteractionErrorValue | null = row.errorCode
    ? InteractionError.parse({
        code: row.errorCode,
        message: row.errorMessage,
        retryable: row.errorRetryable,
        ...(row.errorDetails ? { details: row.errorDetails } : {}),
      })
    : null;
  return InteractionLifecycleOperationReceipt.parse({
    operationId: row.operationId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    kind: row.kind,
    state: row.state,
    replayed,
    error,
    createdAt: iso(row.createdAt),
    dispatchedAt: row.dispatchedAt ? iso(row.dispatchedAt) : null,
    settledAt: row.settledAt ? iso(row.settledAt) : null,
  });
}

async function loadAssociations(
  db: Database,
  workspaceId: string,
  browserSessionIds: readonly string[],
): Promise<BrowserAssociationRow[]> {
  if (browserSessionIds.length === 0) return [];
  return await db
    .select()
    .from(schema.browserSessionAssociations)
    .where(
      and(
        eq(schema.browserSessionAssociations.workspaceId, workspaceId),
        inArray(schema.browserSessionAssociations.browserSessionId, [...browserSessionIds]),
      ),
    )
    .orderBy(
      desc(schema.browserSessionAssociations.lastUsedAt),
      desc(schema.browserSessionAssociations.createdAt),
    );
}

async function loadBrowserSession(
  db: Database,
  workspaceId: string,
  browserSessionId: string,
): Promise<ReturnType<typeof browserSessionFromRows> | null> {
  const [row] = await db
    .select()
    .from(schema.browserSessions)
    .where(
      and(
        eq(schema.browserSessions.workspaceId, workspaceId),
        eq(schema.browserSessions.id, browserSessionId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const associations = await loadAssociations(db, workspaceId, [row.id]);
  return browserSessionFromRows(row, associations);
}

async function loadOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<InteractionOperationRow | null> {
  const [row] = await db
    .select()
    .from(schema.interactionOperations)
    .where(
      and(
        eq(schema.interactionOperations.workspaceId, workspaceId),
        eq(schema.interactionOperations.operationId, operationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function requestDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function browserSessionCreateRequestDigest(input: PrepareBrowserSessionCreateInput): string {
  const revisionSelection = input.identityId
    ? input.resolveDefaultRevision
      ? { kind: "identity_default" as const }
      : input.baseRevisionId
        ? { kind: "exact" as const, revisionId: input.baseRevisionId }
        : { kind: "blank_identity" as const }
    : { kind: "none" as const };
  return requestDigest({
    version: 3,
    associatedSessionId: input.associatedSessionId,
    name: input.name,
    initialUrl: input.initialUrl,
    placement: input.placement,
    driverId: input.driverId,
    engine: input.engine,
    headless: input.headless,
    identityId: input.identityId,
    networkRouteId: input.networkRouteId ?? null,
    linkedComputerSessionId: input.linkedComputerSessionId ?? null,
    revisionSelection,
    capabilities: normalizedBrowserCapabilities(input),
    actorSubjectId: input.actorSubjectId,
  });
}

function lifecycleRequestDigest(
  browserSessionId: string,
  kind: InteractionLifecycleOperationKind,
  actorSubjectId: string,
): string {
  return requestDigest({ version: 1, browserSessionId, kind, actorSubjectId });
}

async function replayedMutation(
  db: Database,
  workspaceId: string,
  operation: InteractionOperationRow,
  expected: { kind: InteractionLifecycleOperationKind; digest: string },
): Promise<BrowserSessionMutationResponseValue> {
  if (
    operation.resourceKind !== "browser_session" ||
    operation.kind !== expected.kind ||
    operation.requestDigest !== expected.digest
  ) {
    throw new BrowserSessionOperationConflictError(
      "Interaction operation id is already bound to another request",
    );
  }
  const session = await loadBrowserSession(db, workspaceId, operation.resourceId);
  if (!session) throw new Error("Interaction operation references a missing BrowserSession");
  return BrowserSessionMutationResponse.parse({
    session,
    operation: operationReceipt(operation, true),
  });
}

export async function listBrowserSessions(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<BrowserSessionListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.workspaceId, input.workspaceId))
        .orderBy(desc(schema.browserSessions.lastUsedAt), desc(schema.browserSessions.id));
      const associations = await loadAssociations(
        scopedDb,
        input.workspaceId,
        rows.map((row) => row.id),
      );
      const associationsByResource = new Map<string, BrowserAssociationRow[]>();
      for (const association of associations) {
        const current = associationsByResource.get(association.browserSessionId) ?? [];
        current.push(association);
        associationsByResource.set(association.browserSessionId, current);
      }
      return BrowserSessionListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        sessions: rows.map((row) =>
          browserSessionFromRows(row, associationsByResource.get(row.id) ?? []),
        ),
      });
    },
    CONSISTENT_READ,
  );
}

export async function getBrowserSession(
  db: Database,
  input: { accountId: string; workspaceId: string; browserSessionId: string },
) {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const session = await loadBrowserSession(scopedDb, input.workspaceId, input.browserSessionId);
      if (!session) throw new BrowserSessionNotFoundError("BrowserSession not found");
      return session;
    },
    CONSISTENT_READ,
  );
}

export async function getBrowserSessionControlRecord(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    browserSessionId: string;
    operationId?: string;
  },
): Promise<BrowserSessionControlRecord> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.browserSessions)
        .where(
          and(
            eq(schema.browserSessions.accountId, input.accountId),
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, input.browserSessionId),
          ),
        )
        .limit(1);
      if (!row) throw new BrowserSessionNotFoundError("BrowserSession not found");

      const operation = input.operationId
        ? await loadOperation(scopedDb, input.workspaceId, input.operationId)
        : null;
      if (input.operationId) assertOperationResource(operation, input.browserSessionId);
      return await controlRecordFromRows(scopedDb, input.workspaceId, row, operation);
    },
    CONSISTENT_READ,
  );
}

export async function getBrowserPrivateCheckpointAuthority(
  db: Database,
  input: { accountId: string; workspaceId: string; browserSessionId: string },
): Promise<BrowserPrivateCheckpointAuthority | null> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const [session] = await scopedDb
        .select({
          id: schema.browserSessions.id,
          artifactId: schema.browserSessions.privateCheckpointArtifactId,
        })
        .from(schema.browserSessions)
        .where(
          and(
            eq(schema.browserSessions.accountId, input.accountId),
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, input.browserSessionId),
          ),
        )
        .limit(1);
      if (!session) throw new BrowserSessionNotFoundError("BrowserSession not found");
      if (!session.artifactId) return null;
      const [artifact] = await scopedDb
        .select()
        .from(schema.browserStateArtifacts)
        .where(
          and(
            eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
            eq(schema.browserStateArtifacts.id, session.artifactId),
          ),
        )
        .limit(1);
      if (
        !artifact ||
        artifact.sourceBrowserSessionId !== session.id ||
        artifact.purpose !== "private_checkpoint" ||
        artifact.state !== "available"
      ) {
        throw new BrowserSessionStateError(
          "BrowserSession private checkpoint authority is inconsistent",
        );
      }
      return {
        artifactId: artifact.id,
        sourceBrowserSessionId: artifact.sourceBrowserSessionId,
        objectKey: artifact.objectKey,
        encryptedDataKey: artifact.encryptedDataKey,
        format: artifact.format,
        artifactDigest: artifact.artifactDigest,
        contentDigest: artifact.contentDigest,
        manifestDigest: artifact.manifestDigest,
        sizeBytes: safeInteger(artifact.sizeBytes, "browser checkpoint artifact size"),
        materialization: BrowserRevisionMaterialization.parse(artifact.materialization),
      };
    },
    CONSISTENT_READ,
  );
}

/** Resolve an idempotency key before inspecting mutable placement. This keeps
 * a retried create bound to its original BrowserSession even if the source
 * session's active sandbox pointer has since changed. */
export async function findBrowserSessionControlRecordByOperation(
  db: Database,
  input: { accountId: string; workspaceId: string; operationId: string },
): Promise<BrowserSessionControlRecord | null> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const operation = await loadOperation(scopedDb, input.workspaceId, input.operationId);
      if (!operation) return null;
      if (operation.resourceKind !== "browser_session") {
        throw new BrowserSessionOperationConflictError(
          "Interaction operation is bound to another resource",
        );
      }
      const [row] = await scopedDb
        .select()
        .from(schema.browserSessions)
        .where(
          and(
            eq(schema.browserSessions.accountId, input.accountId),
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, operation.resourceId),
          ),
        )
        .limit(1);
      if (!row) throw new Error("BrowserSession operation references a missing resource");
      return await controlRecordFromRows(scopedDb, input.workspaceId, row, operation);
    },
    CONSISTENT_READ,
  );
}

async function controlRecordFromRows(
  db: Database,
  workspaceId: string,
  row: BrowserSessionRow,
  operation: InteractionOperationRow | null,
): Promise<BrowserSessionControlRecord> {
  const associations = await loadAssociations(db, workspaceId, [row.id]);
  const createdAssociations = associations.filter(
    (association) => association.relationship === "created",
  );
  if (createdAssociations.length !== 1) {
    throw new Error("BrowserSession must have exactly one creation association");
  }
  return {
    session: browserSessionFromRows(row, associations),
    tokenGeneration: row.tokenGeneration,
    sourceSessionId: createdAssociations[0]!.sessionId,
    createOperationId: row.createOperationId,
    networkRouteAuthority: networkRouteAuthorityFromRow(row),
    operation: operation
      ? {
          operationId: operation.operationId,
          kind: operation.kind,
          state: operation.state,
          controllerGeneration: operation.controllerGeneration,
          actorSubjectId: operation.actorSubjectId,
        }
      : null,
  };
}

function networkRouteAuthorityFromRow(
  row: BrowserSessionRow,
): BrowserSessionNetworkRouteAuthority | null {
  if (!row.networkRouteId) return null;
  if (!row.networkRouteVersion || !row.networkRouteConfiguration || !row.networkRouteConsistency) {
    throw new Error("BrowserSession network route is missing its pinned authority");
  }
  return {
    routeId: row.networkRouteId,
    routeVersion: row.networkRouteVersion,
    credentialVersion: row.networkRouteCredentialVersion,
    authorityDigest: row.networkRouteAuthorityDigest,
    configuration: NetworkRouteConfiguration.parse(row.networkRouteConfiguration),
    consistency: NetworkRouteConsistency.parse(row.networkRouteConsistency),
  };
}

export async function prepareBrowserSessionCreate(
  db: Database,
  input: PrepareBrowserSessionCreateInput,
): Promise<BrowserSessionMutationResponseValue> {
  const digest = browserSessionCreateRequestDigest(input);
  const browserSessionId = randomUUID();
  const capabilities = normalizedBrowserCapabilities(input);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx.execute(sql`
        select id from workspaces
        where id = ${input.workspaceId} and account_id = ${input.accountId}
        for key share
      `);
        const existingOperation = await loadOperation(tx, input.workspaceId, input.operationId);
        if (existingOperation) {
          return await replayedMutation(tx, input.workspaceId, existingOperation, {
            kind: "create",
            digest,
          });
        }
        const [sourceSession] = await tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.associatedSessionId),
            ),
          )
          .limit(1);
        if (!sourceSession) throw new BrowserSessionNotFoundError("Associated session not found");
        await assertLinkedComputerAvailable(tx, input);
        const networkRoute = await assertNetworkRouteAvailable(tx, input);
        const identitySelection = await resolveCreateIdentitySelection(tx, input);

        const [insertedOperation] = await tx
          .insert(schema.interactionOperations)
          .values({
            operationId: input.operationId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            resourceKind: "browser_session",
            resourceId: browserSessionId,
            kind: "create",
            requestDigest: digest,
            state: "prepared",
            actorSubjectId: input.actorSubjectId,
          })
          .onConflictDoNothing({
            target: schema.interactionOperations.operationId,
          })
          .returning();
        if (!insertedOperation) {
          const existing = await loadOperation(tx, input.workspaceId, input.operationId);
          if (!existing) {
            throw new BrowserSessionOperationConflictError(
              "Interaction operation id belongs to another workspace",
            );
          }
          return await replayedMutation(tx, input.workspaceId, existing, {
            kind: "create",
            digest,
          });
        }

        const placementColumns = placementToColumns(input.placement);
        const [insertedSession] = await tx
          .insert(schema.browserSessions)
          .values({
            id: browserSessionId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            name: input.name,
            lifecycle: "starting",
            ...placementColumns,
            driverId: input.driverId,
            engine: input.engine,
            headless: input.headless,
            identityId: identitySelection.identityId,
            baseRevisionId: identitySelection.baseRevisionId,
            networkRouteId: input.networkRouteId ?? null,
            networkRouteVersion: networkRoute?.version ?? null,
            networkRouteConfiguration: networkRoute?.configuration ?? null,
            networkRouteConsistency: networkRoute?.consistency ?? null,
            linkedComputerSessionId: input.linkedComputerSessionId ?? null,
            capabilities,
            createOperationId: input.operationId,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        if (!insertedSession) throw new Error("BrowserSession insert did not return its row");
        const [association] = await tx
          .insert(schema.browserSessionAssociations)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            browserSessionId,
            sessionId: input.associatedSessionId,
            turnId: null,
            attemptId: null,
            relationship: "created",
            actorSubjectId: input.actorSubjectId,
          })
          .returning();
        if (!association) throw new Error("BrowserSession association insert failed");
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return BrowserSessionMutationResponse.parse({
          session: browserSessionFromRows(insertedSession, [association]),
          operation: operationReceipt(insertedOperation, false),
        });
      }),
  );
}

/**
 * Bind the broker-resolved, secret-free launch authority before controller
 * dispatch. A prepared operation may refresh this binding while no physical
 * controller owns it; after dispatch it is immutable and replay-fenced.
 */
export async function bindBrowserSessionNetworkRouteAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    browserSessionId: string;
    operationId: string;
    routeVersion: number;
    credentialVersion: number | null;
    authorityDigest: string;
  },
): Promise<BrowserSessionNetworkRouteAuthority> {
  if (!Number.isSafeInteger(input.routeVersion) || input.routeVersion < 1) {
    throw new BrowserSessionStateError("Network route version is invalid");
  }
  if (
    input.credentialVersion !== null &&
    (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1)
  ) {
    throw new BrowserSessionStateError("Network route credential version is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{16,256}$/u.test(input.authorityDigest)) {
    throw new BrowserSessionStateError("Network route authority digest is invalid");
  }
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId);
        if (operation!.kind !== "create" && operation!.kind !== "resume") {
          throw new BrowserSessionOperationConflictError(
            "Network route authority belongs to another browser operation",
          );
        }
        const [current] = await tx
          .select()
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.accountId, input.accountId),
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) throw new BrowserSessionNotFoundError("BrowserSession not found");
        if (
          !current.networkRouteId ||
          current.networkRouteVersion !== input.routeVersion ||
          !current.networkRouteConfiguration ||
          !current.networkRouteConsistency
        ) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession route does not match this launch authority",
          );
        }
        const configuration = NetworkRouteConfiguration.parse(current.networkRouteConfiguration);
        const hasCredential = "credential" in configuration && configuration.credential !== null;
        if (hasCredential !== (input.credentialVersion !== null)) {
          throw new BrowserSessionStateError(
            "Network route credential authority does not match its configuration",
          );
        }
        if (
          current.networkRouteAuthorityDigest === input.authorityDigest &&
          current.networkRouteCredentialVersion === input.credentialVersion
        ) {
          return networkRouteAuthorityFromRow(current)!;
        }
        if (
          operation!.state !== "prepared" ||
          operation!.controllerGeneration !== null ||
          current.controllerGeneration !== null
        ) {
          throw new BrowserSessionOperationConflictError(
            "Dispatched BrowserSession route authority is immutable",
          );
        }
        const [updated] = await tx
          .update(schema.browserSessions)
          .set({
            networkRouteCredentialVersion: input.credentialVersion,
            networkRouteAuthorityDigest: input.authorityDigest,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              eq(schema.browserSessions.networkRouteVersion, input.routeVersion),
              isNull(schema.browserSessions.controllerGeneration),
            ),
          )
          .returning();
        if (!updated) {
          throw new BrowserSessionOperationConflictError(
            "Network route authority binding lost its fence",
          );
        }
        return networkRouteAuthorityFromRow(updated)!;
      }),
  );
}

function normalizedBrowserCapabilities(
  input: PrepareBrowserSessionCreateInput,
): BrowserSessionCapabilitiesValue {
  return BrowserSessionCapabilities.parse({
    ...(input.capabilities ?? MANAGED_BROWSER_SESSION_CAPABILITIES),
    linkedComputer: input.linkedComputerSessionId != null,
  });
}

async function assertNetworkRouteAvailable(
  db: Database,
  input: PrepareBrowserSessionCreateInput,
): Promise<{
  version: number;
  configuration: NetworkRouteConfigurationValue;
  consistency: NetworkRouteConsistencyValue;
} | null> {
  const networkRouteId = input.networkRouteId ?? null;
  if (!networkRouteId) return null;
  const [route] = await db
    .select()
    .from(schema.networkRoutes)
    .where(
      and(
        eq(schema.networkRoutes.accountId, input.accountId),
        eq(schema.networkRoutes.workspaceId, input.workspaceId),
        eq(schema.networkRoutes.id, networkRouteId),
      ),
    )
    .limit(1)
    .for("update");
  if (!route) throw new BrowserSessionNotFoundError("Network route not found");
  if (route.status !== "active") {
    throw new BrowserSessionStateError("Network route is archived");
  }
  if (
    route.configuration.kind === "tunnel" &&
    !placementsEqual(route.configuration.placement, input.placement)
  ) {
    throw new BrowserSessionStateError("Tunnel route is bound to another placement");
  }
  const configuration = NetworkRouteConfiguration.parse(route.configuration);
  const consistency = NetworkRouteConsistency.parse(route.consistency);
  if (configuration.kind === "managed") {
    throw new BrowserSessionStateError(
      "Managed provider routes require an external browser provider driver",
    );
  }
  const expectedDns = configuration.kind === "proxy" ? "proxy" : "placement";
  if (consistency.dns !== expectedDns) {
    throw new BrowserSessionStateError(
      `Network route ${configuration.kind} cannot provide ${consistency.dns} DNS`,
    );
  }
  if (consistency.webRtc === "proxy_only" && configuration.kind !== "proxy") {
    throw new BrowserSessionStateError("WebRTC proxy-only routing requires a proxy network route");
  }
  if (input.placement.kind === "attached_device") {
    if (configuration.kind === "proxy") {
      throw new BrowserSessionStateError(
        "Attached Chrome cannot change its process-scoped proxy configuration",
      );
    }
    if (
      consistency.locale !== null ||
      consistency.timezone !== null ||
      consistency.geolocation !== null ||
      consistency.webRtc !== "default"
    ) {
      throw new BrowserSessionStateError(
        "Attached Chrome cannot change process-scoped route emulation",
      );
    }
  }
  return {
    version: safeInteger(route.version, "network route version"),
    configuration,
    consistency,
  };
}

function placementsEqual(left: InteractionPlacement, right: InteractionPlacement): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "sandbox_group":
      return right.kind === "sandbox_group" && left.sandboxGroupId === right.sandboxGroupId;
    case "connected_machine":
      return right.kind === "connected_machine" && left.sandboxId === right.sandboxId;
    case "attached_device":
      return right.kind === "attached_device" && left.deviceId === right.deviceId;
    case "external_provider":
      return (
        right.kind === "external_provider" &&
        left.providerId === right.providerId &&
        left.placementId === right.placementId
      );
  }
}

async function assertLinkedComputerAvailable(
  db: Database,
  input: PrepareBrowserSessionCreateInput,
): Promise<void> {
  const computerSessionId = input.linkedComputerSessionId ?? null;
  if (!computerSessionId) return;
  if (input.headless) {
    throw new BrowserSessionStateError("A linked ComputerSession requires a headed browser");
  }
  if (input.placement.kind === "attached_device") {
    throw new BrowserSessionStateError(
      "Attached Chrome does not expose an exact linked ComputerSession yet",
    );
  }
  const [computer] = await db
    .select()
    .from(schema.computerSessions)
    .where(
      and(
        eq(schema.computerSessions.accountId, input.accountId),
        eq(schema.computerSessions.workspaceId, input.workspaceId),
        eq(schema.computerSessions.id, computerSessionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!computer) throw new BrowserSessionNotFoundError("Linked ComputerSession not found");
  if (
    computer.lifecycle !== "active" ||
    computer.controllerGeneration === null ||
    computer.placementInstanceId === null
  ) {
    throw new BrowserSessionStateError("Linked ComputerSession is not active");
  }
  if (!computerMatchesPlacement(computer, input.placement)) {
    throw new BrowserSessionStateError("Linked ComputerSession is on another placement");
  }
}

function computerMatchesPlacement(
  row: typeof schema.computerSessions.$inferSelect,
  placement: InteractionPlacement,
): boolean {
  switch (placement.kind) {
    case "sandbox_group":
      return (
        row.placementKind === "sandbox_group" && row.sandboxGroupId === placement.sandboxGroupId
      );
    case "connected_machine":
      return (
        row.placementKind === "connected_machine" && row.connectedSandboxId === placement.sandboxId
      );
    case "attached_device":
      return row.placementKind === "attached_device" && row.deviceId === placement.deviceId;
    case "external_provider":
      return (
        row.placementKind === "external_provider" &&
        row.externalProviderId === placement.providerId &&
        row.externalPlacementId === placement.placementId
      );
  }
}

async function resolveCreateIdentitySelection(
  db: Database,
  input: PrepareBrowserSessionCreateInput,
): Promise<{ identityId: string | null; baseRevisionId: string | null }> {
  const resolveDefault = input.resolveDefaultRevision ?? false;
  if (!input.identityId) {
    if (input.baseRevisionId || resolveDefault) {
      throw new BrowserSessionStateError("BrowserSession revision selection requires an identity");
    }
    return { identityId: null, baseRevisionId: null };
  }
  if (resolveDefault && input.baseRevisionId) {
    throw new BrowserSessionStateError(
      "BrowserSession cannot select both a default and exact revision",
    );
  }
  await db.execute(sql`
    select id from browser_identities
    where workspace_id = ${input.workspaceId} and id = ${input.identityId}
    for share
  `);
  const [identity] = await db
    .select({
      id: schema.browserIdentities.id,
      status: schema.browserIdentities.status,
      defaultRevisionId: schema.browserIdentities.defaultRevisionId,
    })
    .from(schema.browserIdentities)
    .where(
      and(
        eq(schema.browserIdentities.workspaceId, input.workspaceId),
        eq(schema.browserIdentities.id, input.identityId),
      ),
    )
    .limit(1);
  if (!identity) throw new BrowserSessionNotFoundError("BrowserIdentity not found");
  if (identity.status !== "active") {
    throw new BrowserSessionStateError("BrowserIdentity is archived");
  }
  const baseRevisionId = resolveDefault ? identity.defaultRevisionId : input.baseRevisionId;
  if (baseRevisionId) {
    const [revision] = await db
      .select({ id: schema.browserRevisions.id })
      .from(schema.browserRevisions)
      .where(
        and(
          eq(schema.browserRevisions.workspaceId, input.workspaceId),
          eq(schema.browserRevisions.identityId, identity.id),
          eq(schema.browserRevisions.id, baseRevisionId),
        ),
      )
      .limit(1);
    if (!revision) {
      throw new BrowserSessionNotFoundError("BrowserRevision not found");
    }
  }
  return { identityId: identity.id, baseRevisionId: baseRevisionId ?? null };
}

function placementToColumns(placement: InteractionPlacement): {
  placementKind: BrowserSessionRow["placementKind"];
  sandboxGroupId: string | null;
  connectedSandboxId: string | null;
  deviceId: string | null;
  externalProviderId: string | null;
  externalPlacementId: string | null;
} {
  return {
    placementKind: placement.kind,
    sandboxGroupId: placement.kind === "sandbox_group" ? placement.sandboxGroupId : null,
    connectedSandboxId: placement.kind === "connected_machine" ? placement.sandboxId : null,
    deviceId: placement.kind === "attached_device" ? placement.deviceId : null,
    externalProviderId: placement.kind === "external_provider" ? placement.providerId : null,
    externalPlacementId: placement.kind === "external_provider" ? placement.placementId : null,
  };
}

export async function dispatchBrowserSessionOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
    controller?: InteractionControllerBinding;
  },
): Promise<InteractionLifecycleOperationReceiptValue> {
  const controller = input.controller ? InteractionControllerBinding.parse(input.controller) : null;
  if (controller && controller.controllerGeneration !== input.controllerGeneration) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession dispatch controller generations disagree",
    );
  }
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId);
        if (operation!.state === "prepared") {
          if (controller) {
            await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
            const now = new Date();
            const [bound] = await tx
              .update(schema.browserSessions)
              .set({
                controllerId: controller.controllerId,
                controllerGeneration: controller.controllerGeneration,
                placementInstanceId: controller.placementInstanceId,
                controllerHeartbeatAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.browserSessions.workspaceId, input.workspaceId),
                  eq(schema.browserSessions.id, input.browserSessionId),
                  inArray(schema.browserSessions.lifecycle, ["starting", "restoring"]),
                ),
              )
              .returning();
            if (!bound) {
              throw new BrowserSessionStateError(
                "BrowserSession cannot accept a controller dispatch binding",
              );
            }
          }
          const [updated] = await tx
            .update(schema.interactionOperations)
            .set({
              state: "dispatched",
              controllerGeneration: input.controllerGeneration,
              dispatchedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.interactionOperations.operationId, input.operationId))
            .returning();
          if (!updated) throw new Error("BrowserSession operation dispatch was lost");
          return operationReceipt(updated, false);
        }
        if (
          operation!.controllerGeneration !== null &&
          operation!.controllerGeneration !== input.controllerGeneration
        ) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession operation belongs to another controller generation",
          );
        }
        if (controller) {
          const [row] = await tx
            .select()
            .from(schema.browserSessions)
            .where(
              and(
                eq(schema.browserSessions.workspaceId, input.workspaceId),
                eq(schema.browserSessions.id, input.browserSessionId),
              ),
            )
            .limit(1);
          const current = row ? controllerFromRow(row) : null;
          if (
            !current ||
            current.controllerId !== controller.controllerId ||
            current.controllerGeneration !== controller.controllerGeneration ||
            current.placementInstanceId !== controller.placementInstanceId
          ) {
            throw new BrowserSessionOperationConflictError(
              "BrowserSession dispatch belongs to another controller binding",
            );
          }
        }
        return operationReceipt(operation!, true);
      }),
  );
}

export async function activateBrowserSession(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controller: InteractionControllerBinding;
    engineVersion: string | null;
  },
): Promise<BrowserSessionMutationResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId);
        if (operation!.state === "completed") {
          return await replayedMutation(tx, input.workspaceId, operation!, {
            kind: operation!.kind,
            digest: operation!.requestDigest,
          });
        }
        if (operation!.state !== "prepared" && operation!.state !== "dispatched") {
          throw new BrowserSessionStateError("BrowserSession operation is already terminal");
        }
        if (
          operation!.controllerGeneration !== null &&
          operation!.controllerGeneration !== input.controller.controllerGeneration
        ) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession activation has a stale controller generation",
          );
        }
        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const [currentSession] = await tx
          .select({
            networkRouteId: schema.browserSessions.networkRouteId,
            networkRouteAuthorityDigest: schema.browserSessions.networkRouteAuthorityDigest,
          })
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .limit(1);
        if (!currentSession) throw new BrowserSessionNotFoundError("BrowserSession not found");
        if (currentSession.networkRouteId && !currentSession.networkRouteAuthorityDigest) {
          throw new BrowserSessionStateError(
            "BrowserSession network route authority was not bound before activation",
          );
        }
        const now = new Date();
        const [sessionRow] = await tx
          .update(schema.browserSessions)
          .set({
            lifecycle: "active",
            controllerId: input.controller.controllerId,
            controllerGeneration: input.controller.controllerGeneration,
            placementInstanceId: input.controller.placementInstanceId,
            engineVersion: input.engineVersion,
            controllerHeartbeatAt: now,
            lastUsedAt: now,
            failureCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              inArray(schema.browserSessions.lifecycle, ["starting", "restoring", "active"]),
            ),
          )
          .returning();
        if (!sessionRow) throw new BrowserSessionStateError("BrowserSession cannot be activated");
        const [operationRow] = await tx
          .update(schema.interactionOperations)
          .set({
            state: "completed",
            controllerGeneration: input.controller.controllerGeneration,
            dispatchedAt: operation!.dispatchedAt ?? now,
            settledAt: now,
            updatedAt: now,
          })
          .where(eq(schema.interactionOperations.operationId, input.operationId))
          .returning();
        if (!operationRow) throw new Error("BrowserSession operation completion was lost");
        const associations = await loadAssociations(tx, input.workspaceId, [
          input.browserSessionId,
        ]);
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return BrowserSessionMutationResponse.parse({
          session: browserSessionFromRows(sessionRow, associations),
          operation: operationReceipt(operationRow, false),
        });
      }),
  );
}

export async function failBrowserSessionOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    state?: "failed" | "outcome_unknown";
    error: InteractionErrorValue;
  },
): Promise<BrowserSessionMutationResponseValue> {
  const error = InteractionError.parse(input.error);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId);
        if (
          operation!.state === "completed" ||
          operation!.state === "failed" ||
          operation!.state === "outcome_unknown"
        ) {
          return await replayedMutation(tx, input.workspaceId, operation!, {
            kind: operation!.kind,
            digest: operation!.requestDigest,
          });
        }
        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const now = new Date();
        const preserveUncertainBinding = input.state === "outcome_unknown";
        const [sessionRow] = await tx
          .update(schema.browserSessions)
          .set({
            lifecycle: input.state === "outcome_unknown" ? "lost" : "failed",
            ...(preserveUncertainBinding
              ? {}
              : {
                  controllerId: null,
                  controllerGeneration: null,
                  placementInstanceId: null,
                }),
            ...(preserveUncertainBinding ? {} : { controllerHeartbeatAt: null }),
            failureCode: error.code,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .returning();
        if (!sessionRow) throw new BrowserSessionNotFoundError("BrowserSession not found");
        const [operationRow] = await tx
          .update(schema.interactionOperations)
          .set({
            state: input.state ?? "failed",
            errorCode: error.code,
            errorMessage: error.message,
            errorRetryable: error.retryable,
            errorDetails: error.details ?? null,
            settledAt: now,
            updatedAt: now,
          })
          .where(eq(schema.interactionOperations.operationId, input.operationId))
          .returning();
        if (!operationRow) throw new Error("BrowserSession failure receipt was lost");
        const associations = await loadAssociations(tx, input.workspaceId, [
          input.browserSessionId,
        ]);
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return BrowserSessionMutationResponse.parse({
          session: browserSessionFromRows(sessionRow, associations),
          operation: operationReceipt(operationRow, false),
        });
      }),
  );
}

export async function prepareBrowserSessionSuspend(
  db: Database,
  input: PrepareBrowserSessionLifecycleInput,
): Promise<BrowserSessionMutationResponseValue> {
  return await prepareBrowserSessionLifecycleTransition(db, input, {
    kind: "suspend",
    terminalLifecycle: "suspended",
    targetLifecycle: "suspending",
    assertReady: (row) => {
      if (row.lifecycle !== "active" || !controllerFromRow(row)) {
        throw new BrowserSessionStateError("Only an active BrowserSession can be suspended");
      }
      const capabilities = BrowserSessionCapabilities.parse(row.capabilities);
      if (!capabilities.privateCheckpoint) {
        throw new BrowserSessionStateError("BrowserSession does not support private checkpoints");
      }
    },
  });
}

export async function prepareBrowserSessionResume(
  db: Database,
  input: PrepareBrowserSessionLifecycleInput,
): Promise<BrowserSessionMutationResponseValue> {
  return await prepareBrowserSessionLifecycleTransition(db, input, {
    kind: "resume",
    terminalLifecycle: "active",
    targetLifecycle: "restoring",
    assertReady: (row) => {
      if (row.lifecycle !== "suspended") {
        throw new BrowserSessionStateError("Only a suspended BrowserSession can be resumed");
      }
      if (controllerFromRow(row)) {
        throw new BrowserSessionStateError(
          "BrowserSession suspension cleanup must finish before resume",
        );
      }
      if (!row.privateCheckpointArtifactId && !row.baseRevisionId) {
        throw new BrowserSessionStateError("BrowserSession has no durable state to resume");
      }
    },
  });
}

async function prepareBrowserSessionLifecycleTransition(
  db: Database,
  input: PrepareBrowserSessionLifecycleInput,
  transition: {
    kind: "suspend" | "resume";
    terminalLifecycle: "suspended" | "active";
    targetLifecycle: "suspending" | "restoring";
    assertReady: (row: BrowserSessionRow) => void;
  },
): Promise<BrowserSessionMutationResponseValue> {
  const digest = lifecycleRequestDigest(
    input.browserSessionId,
    transition.kind,
    input.actorSubjectId,
  );
  try {
    return await withRlsContext(
      db,
      input,
      async (scopedDb) =>
        await scopedDb.transaction(async (txRaw) => {
          const tx = txRaw as unknown as Database;
          await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
          const [row] = await tx
            .select()
            .from(schema.browserSessions)
            .where(
              and(
                eq(schema.browserSessions.workspaceId, input.workspaceId),
                eq(schema.browserSessions.id, input.browserSessionId),
              ),
            )
            .limit(1);
          if (!row) throw new BrowserSessionNotFoundError("BrowserSession not found");

          const existing = await loadOperation(tx, input.workspaceId, input.operationId);
          if (existing) {
            return await replayedMutation(tx, input.workspaceId, existing, {
              kind: transition.kind,
              digest,
            });
          }

          const terminal = row.lifecycle === transition.terminalLifecycle;
          if (!terminal) transition.assertReady(row);
          const now = new Date();
          const [operation] = await tx
            .insert(schema.interactionOperations)
            .values({
              operationId: input.operationId,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              resourceKind: "browser_session",
              resourceId: input.browserSessionId,
              kind: transition.kind,
              requestDigest: digest,
              state: terminal ? "completed" : "prepared",
              actorSubjectId: input.actorSubjectId,
              ...(terminal ? { dispatchedAt: now, settledAt: now } : {}),
            })
            .returning();
          if (!operation) throw new Error("BrowserSession lifecycle operation insert was lost");

          const sessionRow = terminal
            ? row
            : (
                await tx
                  .update(schema.browserSessions)
                  .set({
                    lifecycle: transition.targetLifecycle,
                    failureCode: null,
                    ...(transition.kind === "resume"
                      ? {
                          networkRouteCredentialVersion: null,
                          networkRouteAuthorityDigest: null,
                        }
                      : {}),
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(schema.browserSessions.workspaceId, input.workspaceId),
                      eq(schema.browserSessions.id, input.browserSessionId),
                    ),
                  )
                  .returning()
              )[0];
          if (!sessionRow) throw new Error("BrowserSession lifecycle transition was lost");
          const associations = await loadAssociations(tx, input.workspaceId, [
            input.browserSessionId,
          ]);
          if (!terminal) {
            await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
          }
          return BrowserSessionMutationResponse.parse({
            session: browserSessionFromRows(sessionRow, associations),
            operation: operationReceipt(operation, false),
          });
        }),
    );
  } catch (error) {
    if (postgresConstraint(error) === "interaction_operations_active_resource_uq") {
      throw new BrowserSessionOperationConflictError(
        "BrowserSession already has an active lifecycle operation",
      );
    }
    throw error;
  }
}

export async function commitBrowserSessionSuspension(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
    artifact: BrowserStateArtifactCommitInput;
  },
): Promise<BrowserSessionMutationResponseValue> {
  let artifact: BrowserStateArtifactCommitInput;
  try {
    artifact = validateBrowserStateArtifactCommitInput(input.workspaceId, input.artifact);
  } catch (error) {
    throw new BrowserSessionStateError(
      error instanceof Error ? error.message : "Browser checkpoint metadata is invalid",
    );
  }
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId, "suspend");
        if (operation!.state === "completed") {
          return await replayedMutation(tx, input.workspaceId, operation!, {
            kind: "suspend",
            digest: operation!.requestDigest,
          });
        }
        if (operation!.state !== "dispatched") {
          throw new BrowserSessionStateError("BrowserSession suspension is not dispatched");
        }
        if (operation!.controllerGeneration !== input.controllerGeneration) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession suspension controller generation changed",
          );
        }

        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const [current] = await tx
          .select()
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .limit(1);
        if (!current) throw new BrowserSessionNotFoundError("BrowserSession not found");
        if (
          current.lifecycle !== "suspending" ||
          current.controllerGeneration !== input.controllerGeneration
        ) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession suspension controller authority changed",
          );
        }

        const now = new Date();
        const artifactId = randomUUID();
        const [artifactRow] = await tx
          .insert(schema.browserStateArtifacts)
          .values({
            id: artifactId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceBrowserSessionId: input.browserSessionId,
            purpose: "private_checkpoint",
            ...artifact,
          })
          .returning({ id: schema.browserStateArtifacts.id });
        if (!artifactRow) throw new Error("Browser checkpoint artifact insert was lost");

        if (current.privateCheckpointArtifactId) {
          const [retired] = await tx
            .update(schema.browserStateArtifacts)
            .set({ state: "delete_pending", retainedUntil: now })
            .where(
              and(
                eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
                eq(schema.browserStateArtifacts.id, current.privateCheckpointArtifactId),
                eq(schema.browserStateArtifacts.sourceBrowserSessionId, input.browserSessionId),
                eq(schema.browserStateArtifacts.purpose, "private_checkpoint"),
                eq(schema.browserStateArtifacts.state, "available"),
              ),
            )
            .returning({ id: schema.browserStateArtifacts.id });
          if (!retired) {
            throw new BrowserSessionStateError(
              "BrowserSession previous private checkpoint authority is inconsistent",
            );
          }
        }

        const [sessionRow] = await tx
          .update(schema.browserSessions)
          .set({
            lifecycle: "suspended",
            privateCheckpointArtifactId: artifactId,
            failureCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              eq(schema.browserSessions.lifecycle, "suspending"),
              eq(schema.browserSessions.controllerGeneration, input.controllerGeneration),
            ),
          )
          .returning();
        const [operationRow] = await tx
          .update(schema.interactionOperations)
          .set({ state: "completed", settledAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.interactionOperations.workspaceId, input.workspaceId),
              eq(schema.interactionOperations.operationId, input.operationId),
              eq(schema.interactionOperations.state, "dispatched"),
            ),
          )
          .returning();
        if (!sessionRow || !operationRow) {
          throw new Error("BrowserSession suspension completion was lost");
        }
        const associations = await loadAssociations(tx, input.workspaceId, [
          input.browserSessionId,
        ]);
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return BrowserSessionMutationResponse.parse({
          session: browserSessionFromRows(sessionRow, associations),
          operation: operationReceipt(operationRow, false),
        });
      }),
  );
}

export async function clearSuspendedBrowserSessionController(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    browserSessionId: string;
    expectedControllerGeneration: string;
  },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
      const [current] = await tx
        .select()
        .from(schema.browserSessions)
        .where(
          and(
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, input.browserSessionId),
          ),
        )
        .limit(1);
      if (!current) throw new BrowserSessionNotFoundError("BrowserSession not found");
      if (current.lifecycle !== "suspended") {
        throw new BrowserSessionStateError("BrowserSession is not suspended");
      }
      if (!current.controllerGeneration) return false;
      if (current.controllerGeneration !== input.expectedControllerGeneration) {
        throw new BrowserSessionOperationConflictError(
          "BrowserSession suspension cleanup has a stale controller generation",
        );
      }
      const [cleared] = await tx
        .update(schema.browserSessions)
        .set({
          controllerId: null,
          controllerGeneration: null,
          placementInstanceId: null,
          controllerHeartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.browserSessions.workspaceId, input.workspaceId),
            eq(schema.browserSessions.id, input.browserSessionId),
            eq(schema.browserSessions.lifecycle, "suspended"),
            eq(schema.browserSessions.controllerGeneration, input.expectedControllerGeneration),
          ),
        )
        .returning({ id: schema.browserSessions.id });
      if (!cleared) throw new Error("BrowserSession suspension cleanup was lost");
      await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
      return true;
    }),
  );
}

export async function failBrowserSessionSuspension(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
    state?: "failed" | "outcome_unknown";
    error: InteractionErrorValue;
  },
): Promise<BrowserSessionMutationResponseValue> {
  return await failBrowserSessionTransition(db, {
    ...input,
    kind: "suspend",
    expectedLifecycle: "suspending",
    resultLifecycle: "active",
    clearController: false,
  });
}

export async function failBrowserSessionResume(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
    error: InteractionErrorValue;
  },
): Promise<BrowserSessionMutationResponseValue> {
  return await failBrowserSessionTransition(db, {
    ...input,
    kind: "resume",
    expectedLifecycle: "restoring",
    resultLifecycle: "suspended",
    state: "failed",
    clearController: true,
  });
}

export async function failBrowserSessionResumePreparation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    error: InteractionErrorValue;
  },
): Promise<BrowserSessionMutationResponseValue> {
  return await failBrowserSessionTransition(db, {
    ...input,
    controllerGeneration: null,
    kind: "resume",
    expectedLifecycle: "restoring",
    resultLifecycle: "suspended",
    state: "failed",
    clearController: true,
  });
}

async function failBrowserSessionTransition(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string | null;
    kind: "suspend" | "resume";
    expectedLifecycle: "suspending" | "restoring";
    resultLifecycle: "active" | "suspended";
    state?: "failed" | "outcome_unknown";
    clearController: boolean;
    error: InteractionErrorValue;
  },
): Promise<BrowserSessionMutationResponseValue> {
  const failure = InteractionError.parse(input.error);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId, input.kind);
        if (
          operation!.state === "completed" ||
          operation!.state === "failed" ||
          operation!.state === "outcome_unknown"
        ) {
          return await replayedMutation(tx, input.workspaceId, operation!, {
            kind: input.kind,
            digest: operation!.requestDigest,
          });
        }
        if (operation!.controllerGeneration !== input.controllerGeneration) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession lifecycle failure has a stale controller generation",
          );
        }
        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const now = new Date();
        const [sessionRow] = await tx
          .update(schema.browserSessions)
          .set({
            lifecycle: input.resultLifecycle,
            ...(input.clearController
              ? {
                  controllerId: null,
                  controllerGeneration: null,
                  placementInstanceId: null,
                  controllerHeartbeatAt: null,
                }
              : {}),
            failureCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              eq(schema.browserSessions.lifecycle, input.expectedLifecycle),
              input.controllerGeneration === null
                ? isNull(schema.browserSessions.controllerGeneration)
                : eq(schema.browserSessions.controllerGeneration, input.controllerGeneration),
            ),
          )
          .returning();
        const [operationRow] = await tx
          .update(schema.interactionOperations)
          .set({
            state: input.state ?? "failed",
            errorCode: failure.code,
            errorMessage: failure.message,
            errorRetryable: failure.retryable,
            errorDetails: failure.details ?? null,
            settledAt: now,
            updatedAt: now,
          })
          .where(eq(schema.interactionOperations.operationId, input.operationId))
          .returning();
        if (!sessionRow || !operationRow) {
          throw new Error("BrowserSession lifecycle failure settlement was lost");
        }
        const associations = await loadAssociations(tx, input.workspaceId, [
          input.browserSessionId,
        ]);
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return BrowserSessionMutationResponse.parse({
          session: browserSessionFromRows(sessionRow, associations),
          operation: operationReceipt(operationRow, false),
        });
      }),
  );
}

export async function prepareBrowserSessionEnd(
  db: Database,
  input: PrepareBrowserSessionEndInput,
): Promise<BrowserSessionMutationResponseValue> {
  const digest = lifecycleRequestDigest(input.browserSessionId, "end", input.actorSubjectId);
  try {
    return await withRlsContext(
      db,
      input,
      async (scopedDb) =>
        await scopedDb.transaction(async (txRaw) => {
          const tx = txRaw as unknown as Database;
          await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
          const session = await loadBrowserSession(tx, input.workspaceId, input.browserSessionId);
          if (!session) throw new BrowserSessionNotFoundError("BrowserSession not found");
          const now = new Date();
          const terminal = session.lifecycle === "ended";
          const [insertedOperation] = await tx
            .insert(schema.interactionOperations)
            .values({
              operationId: input.operationId,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              resourceKind: "browser_session",
              resourceId: input.browserSessionId,
              kind: "end",
              requestDigest: digest,
              state: terminal ? "completed" : "prepared",
              actorSubjectId: input.actorSubjectId,
              ...(terminal ? { dispatchedAt: now, settledAt: now } : {}),
            })
            .onConflictDoNothing({
              target: schema.interactionOperations.operationId,
            })
            .returning();
          if (!insertedOperation) {
            const existing = await loadOperation(tx, input.workspaceId, input.operationId);
            if (!existing) {
              throw new BrowserSessionOperationConflictError(
                "Interaction operation id belongs to another workspace",
              );
            }
            return await replayedMutation(tx, input.workspaceId, existing, {
              kind: "end",
              digest,
            });
          }
          if (terminal) {
            return BrowserSessionMutationResponse.parse({
              session,
              operation: operationReceipt(insertedOperation, false),
            });
          }
          const [sessionRow] = await tx
            .update(schema.browserSessions)
            .set({ lifecycle: "ending", failureCode: null, updatedAt: now })
            .where(
              and(
                eq(schema.browserSessions.workspaceId, input.workspaceId),
                eq(schema.browserSessions.id, input.browserSessionId),
              ),
            )
            .returning();
          if (!sessionRow) throw new BrowserSessionNotFoundError("BrowserSession not found");
          const associations = await loadAssociations(tx, input.workspaceId, [
            input.browserSessionId,
          ]);
          await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
          return BrowserSessionMutationResponse.parse({
            session: browserSessionFromRows(sessionRow, associations),
            operation: operationReceipt(insertedOperation, false),
          });
        }),
    );
  } catch (error) {
    if (postgresConstraint(error) === "interaction_operations_active_resource_uq") {
      throw new BrowserSessionOperationConflictError(
        "BrowserSession already has an active lifecycle operation",
      );
    }
    throw error;
  }
}

export async function completeBrowserSessionEnd(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    expectedControllerGeneration: string | null;
  },
): Promise<BrowserSessionMutationResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadOperation(tx, input.workspaceId, input.operationId);
        assertOperationResource(operation, input.browserSessionId, "end");
        if (operation!.state === "completed") {
          return await replayedMutation(tx, input.workspaceId, operation!, {
            kind: "end",
            digest: operation!.requestDigest,
          });
        }
        if (operation!.state !== "prepared" && operation!.state !== "dispatched") {
          throw new BrowserSessionStateError("BrowserSession end operation is already terminal");
        }
        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const [current] = await tx
          .select()
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .limit(1);
        if (!current) throw new BrowserSessionNotFoundError("BrowserSession not found");
        if (current.controllerGeneration !== input.expectedControllerGeneration) {
          throw new BrowserSessionOperationConflictError(
            "BrowserSession end has a stale controller generation",
          );
        }
        const now = new Date();
        if (current.privateCheckpointArtifactId) {
          const [retired] = await tx
            .update(schema.browserStateArtifacts)
            .set({ state: "delete_pending", retainedUntil: now })
            .where(
              and(
                eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
                eq(schema.browserStateArtifacts.id, current.privateCheckpointArtifactId),
                eq(schema.browserStateArtifacts.sourceBrowserSessionId, input.browserSessionId),
                eq(schema.browserStateArtifacts.purpose, "private_checkpoint"),
                eq(schema.browserStateArtifacts.state, "available"),
              ),
            )
            .returning({ id: schema.browserStateArtifacts.id });
          if (!retired) {
            throw new BrowserSessionStateError(
              "BrowserSession private checkpoint authority is inconsistent",
            );
          }
        }
        const [sessionRow] = await tx
          .update(schema.browserSessions)
          .set({
            lifecycle: "ended",
            controllerId: null,
            controllerGeneration: null,
            placementInstanceId: null,
            controllerHeartbeatAt: null,
            privateCheckpointArtifactId: null,
            failureCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .returning();
        const [operationRow] = await tx
          .update(schema.interactionOperations)
          .set({
            state: "completed",
            controllerGeneration: input.expectedControllerGeneration,
            dispatchedAt: operation!.dispatchedAt ?? now,
            settledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.interactionOperations.workspaceId, input.workspaceId),
              eq(schema.interactionOperations.operationId, input.operationId),
            ),
          )
          .returning();
        if (!sessionRow || !operationRow) throw new Error("BrowserSession end completion was lost");
        const associations = await loadAssociations(tx, input.workspaceId, [
          input.browserSessionId,
        ]);
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return BrowserSessionMutationResponse.parse({
          session: browserSessionFromRows(sessionRow, associations),
          operation: operationReceipt(operationRow, false),
        });
      }),
  );
}

export async function touchBrowserSessionController(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    browserSessionId: string;
    controllerGeneration: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [observed] = await tx
          .select()
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              eq(schema.browserSessions.lifecycle, "active"),
              eq(schema.browserSessions.controllerGeneration, input.controllerGeneration),
            ),
          )
          .limit(1);
        if (!observed) return false;
        if (observed.placementKind === "sandbox_group") {
          // Match the reaper's exact lease -> holder -> BrowserSession lock
          // order. The pre-lock observation is only a locator; every authority
          // predicate is repeated below while the corresponding row is locked.
          const lease = await tx.execute<{ id: string }>(sql`
            select lease.id
            from sandbox_leases lease
            join browser_sessions browser
              on browser.account_id = lease.account_id
             and browser.workspace_id = lease.workspace_id
             and browser.sandbox_group_id = lease.sandbox_group_id
            where browser.account_id = ${input.accountId}
              and browser.workspace_id = ${input.workspaceId}
              and browser.id = ${input.browserSessionId}
              and browser.lifecycle = 'active'
              and browser.controller_generation = ${input.controllerGeneration}
              and browser.placement_instance_id = lease.instance_id
            for update of lease
          `);
          if (!lease[0]) return false;
          const holder = await tx.execute<{ id: string }>(sql`
          update sandbox_lease_holders holder set last_heartbeat_at = now()
          from sandbox_leases lease
          where lease.id = holder.lease_id
            and holder.account_id = ${input.accountId}
            and holder.workspace_id = ${input.workspaceId}
            and holder.kind = 'interaction'
            and holder.holder_id = ${`browser-session:${input.browserSessionId}`}
            and lease.workspace_id = ${input.workspaceId}
            and lease.sandbox_group_id = ${observed.sandboxGroupId}
            and lease.instance_id = ${observed.placementInstanceId}
          returning holder.id
        `);
          if (!holder[0]) return false;
        }
        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const now = new Date();
        const [updated] = await tx
          .update(schema.browserSessions)
          .set({ controllerHeartbeatAt: now, lastUsedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              eq(schema.browserSessions.lifecycle, "active"),
              eq(schema.browserSessions.controllerGeneration, input.controllerGeneration),
            ),
          )
          .returning({ id: schema.browserSessions.id });
        return updated !== undefined;
      }),
  );
}

async function lockOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<void> {
  await db.execute(sql`
    select operation_id from interaction_operations
    where workspace_id = ${workspaceId} and operation_id = ${operationId}
    for update
  `);
}

async function lockBrowserSession(
  db: Database,
  workspaceId: string,
  browserSessionId: string,
): Promise<void> {
  await db.execute(sql`
    select id from browser_sessions
    where workspace_id = ${workspaceId} and id = ${browserSessionId}
    for update
  `);
}

function assertOperationResource(
  operation: InteractionOperationRow | null,
  browserSessionId: string,
  kind?: InteractionLifecycleOperationKind,
): asserts operation is InteractionOperationRow {
  if (!operation) throw new BrowserSessionNotFoundError("BrowserSession operation not found");
  if (
    operation.resourceKind !== "browser_session" ||
    operation.resourceId !== browserSessionId ||
    (kind !== undefined && operation.kind !== kind)
  ) {
    throw new BrowserSessionOperationConflictError(
      "Interaction operation is bound to another resource",
    );
  }
}

function postgresConstraint(error: unknown): string | null {
  return safeDatabaseErrorFacts(error).constraint ?? null;
}
