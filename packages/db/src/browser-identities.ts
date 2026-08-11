import { createHash, randomUUID } from "node:crypto";
import {
  BrowserIdentity,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserRevision,
  BrowserRevisionListResponse,
  BrowserRevisionMaterialization,
  BrowserSessionCapabilities,
  InteractionError,
  PublishBrowserRevisionResponse,
  type BrowserIdentity as BrowserIdentityValue,
  type BrowserIdentityListResponse as BrowserIdentityListResponseValue,
  type BrowserIdentityMutationResponse as BrowserIdentityMutationResponseValue,
  type BrowserRevision as BrowserRevisionValue,
  type BrowserRevisionListResponse as BrowserRevisionListResponseValue,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
  type InteractionError as InteractionErrorValue,
  type PublishBrowserRevisionResponse as PublishBrowserRevisionResponseValue,
} from "@opengeni/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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

type BrowserIdentityRow = typeof schema.browserIdentities.$inferSelect;
type BrowserRevisionRow = typeof schema.browserRevisions.$inferSelect;
type BrowserRevisionComponentRow = typeof schema.browserRevisionComponents.$inferSelect;
type BrowserStateArtifactRow = typeof schema.browserStateArtifacts.$inferSelect;
type BrowserSessionRow = typeof schema.browserSessions.$inferSelect;
type InteractionOperationRow = typeof schema.interactionOperations.$inferSelect;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_COMPONENTS = 16;
const CONSISTENT_READ = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

export class BrowserIdentityNotFoundError extends Error {
  readonly name = "BrowserIdentityNotFoundError";
}

export class BrowserIdentityConflictError extends Error {
  readonly name = "BrowserIdentityConflictError";
}

export class BrowserIdentityStateError extends Error {
  readonly name = "BrowserIdentityStateError";
}

export type { BrowserStateArtifactCommitInput } from "./browser-state-artifacts";

export type BrowserRevisionPublicationPreparation =
  | {
      kind: "completed";
      response: PublishBrowserRevisionResponseValue;
    }
  | {
      kind: "pending";
      operationState: "prepared" | "dispatched";
      browserSessionId: string;
      controllerGeneration: string;
      identity: BrowserIdentityValue;
      parentRevisionId: string | null;
    };

export type BrowserRevisionPublicationDispatch =
  | {
      kind: "completed";
      response: PublishBrowserRevisionResponseValue;
    }
  | {
      kind: "dispatched";
      browserSessionId: string;
      controllerGeneration: string;
      replayed: boolean;
    };

export type BrowserRevisionArtifactAuthority = {
  revision: BrowserRevisionValue;
  artifacts: Array<{
    componentId: string;
    artifactId: string;
    objectKey: string;
    encryptedDataKey: string;
    contentDigest: string;
    manifestDigest: string;
    artifactDigest: string;
    sizeBytes: number;
    format: string;
    materialization: BrowserRevisionMaterializationValue;
  }>;
};

function iso(value: Date): string {
  return value.toISOString();
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is outside safe range`);
  return value;
}

function identityFromRow(row: BrowserIdentityRow): BrowserIdentityValue {
  return BrowserIdentity.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    defaultRevisionId: row.defaultRevisionId,
    headGeneration: safeInteger(row.headGeneration, "BrowserIdentity head generation"),
    revisionCount: safeInteger(row.revisionCount, "BrowserIdentity revision count"),
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function revisionFromRows(
  row: BrowserRevisionRow,
  components: readonly BrowserRevisionComponentRow[],
  artifacts: ReadonlyMap<string, BrowserStateArtifactRow>,
): BrowserRevisionValue {
  return BrowserRevision.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    identityId: row.identityId,
    parentRevisionId: row.parentRevisionId,
    ordinal: safeInteger(row.ordinal, "BrowserRevision ordinal"),
    sourceBrowserSessionId: row.sourceBrowserSessionId,
    manifestDigest: row.manifestDigest,
    components: [...components]
      .sort((left, right) => left.position - right.position)
      .map((component) => {
        const artifact = artifacts.get(component.artifactId);
        if (
          !artifact ||
          artifact.state !== "available" ||
          artifact.purpose !== component.artifactPurpose ||
          artifact.kind !== component.kind ||
          artifact.sourceBrowserSessionId !== component.sourceBrowserSessionId ||
          component.sourceBrowserSessionId !== row.sourceBrowserSessionId
        ) {
          throw new Error("BrowserRevision references invalid or unavailable state authority");
        }
        return {
          id: component.id,
          kind: component.kind,
          format: artifact.format,
          artifactDigest: artifact.artifactDigest,
          sizeBytes: safeInteger(artifact.sizeBytes, "browser artifact size"),
          materialization: BrowserRevisionMaterialization.parse(artifact.materialization),
        };
      }),
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  });
}

async function loadIdentity(
  db: Database,
  workspaceId: string,
  identityId: string,
): Promise<BrowserIdentityRow | null> {
  const [row] = await db
    .select()
    .from(schema.browserIdentities)
    .where(
      and(
        eq(schema.browserIdentities.workspaceId, workspaceId),
        eq(schema.browserIdentities.id, identityId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadRevisionRows(
  db: Database,
  workspaceId: string,
  filter: { identityId?: string; operationId?: string; revisionId?: string },
): Promise<BrowserRevisionRow[]> {
  const predicates = [eq(schema.browserRevisions.workspaceId, workspaceId)];
  if (filter.identityId) predicates.push(eq(schema.browserRevisions.identityId, filter.identityId));
  if (filter.operationId) {
    predicates.push(eq(schema.browserRevisions.publicationOperationId, filter.operationId));
  }
  if (filter.revisionId) predicates.push(eq(schema.browserRevisions.id, filter.revisionId));
  return await db
    .select()
    .from(schema.browserRevisions)
    .where(and(...predicates))
    .orderBy(desc(schema.browserRevisions.ordinal), desc(schema.browserRevisions.id));
}

async function materializeRevisions(
  db: Database,
  rows: readonly BrowserRevisionRow[],
): Promise<BrowserRevisionValue[]> {
  if (rows.length === 0) return [];
  const revisionIds = rows.map((row) => row.id);
  const components = await db
    .select()
    .from(schema.browserRevisionComponents)
    .where(inArray(schema.browserRevisionComponents.revisionId, revisionIds))
    .orderBy(asc(schema.browserRevisionComponents.position));
  const artifactIds = components.map((component) => component.artifactId);
  const artifacts = artifactIds.length
    ? await db
        .select()
        .from(schema.browserStateArtifacts)
        .where(inArray(schema.browserStateArtifacts.id, artifactIds))
    : [];
  const byRevision = new Map<string, BrowserRevisionComponentRow[]>();
  for (const component of components) {
    const current = byRevision.get(component.revisionId) ?? [];
    current.push(component);
    byRevision.set(component.revisionId, current);
  }
  const byArtifact = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return rows.map((row) => revisionFromRows(row, byRevision.get(row.id) ?? [], byArtifact));
}

async function loadPublicationResponse(
  db: Database,
  workspaceId: string,
  operationId: string,
  replayed: boolean,
): Promise<PublishBrowserRevisionResponseValue | null> {
  const rows = await loadRevisionRows(db, workspaceId, { operationId });
  const row = rows[0];
  if (!row) return null;
  const identity = await loadIdentity(db, workspaceId, row.identityId);
  if (!identity) throw new Error("BrowserRevision references a missing identity");
  const [revision] = await materializeRevisions(db, [row]);
  if (!revision) throw new Error("BrowserRevision could not be materialized");
  return PublishBrowserRevisionResponse.parse({
    identity: identityFromRow(identity),
    revision,
    outcome: row.defaultAdvanced ? "saved_as_default" : "saved_not_default",
    replayed,
  });
}

export async function listBrowserIdentities(
  db: Database,
  input: { accountId: string; workspaceId: string; includeArchived?: boolean },
): Promise<BrowserIdentityListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.browserIdentities)
        .where(
          input.includeArchived
            ? eq(schema.browserIdentities.workspaceId, input.workspaceId)
            : and(
                eq(schema.browserIdentities.workspaceId, input.workspaceId),
                eq(schema.browserIdentities.status, "active"),
              ),
        )
        .orderBy(desc(schema.browserIdentities.updatedAt), asc(schema.browserIdentities.name));
      return BrowserIdentityListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        identities: rows.map(identityFromRow),
      });
    },
    CONSISTENT_READ,
  );
}

export async function getBrowserIdentity(
  db: Database,
  input: { accountId: string; workspaceId: string; identityId: string },
): Promise<BrowserIdentityValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const row = await loadIdentity(scopedDb, input.workspaceId, input.identityId);
      if (!row) throw new BrowserIdentityNotFoundError("BrowserIdentity not found");
      return identityFromRow(row);
    },
    CONSISTENT_READ,
  );
}

export async function listBrowserRevisions(
  db: Database,
  input: { accountId: string; workspaceId: string; identityId: string },
): Promise<BrowserRevisionListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const identity = await loadIdentity(scopedDb, input.workspaceId, input.identityId);
      if (!identity) throw new BrowserIdentityNotFoundError("BrowserIdentity not found");
      const revisions = await materializeRevisions(
        scopedDb,
        await loadRevisionRows(scopedDb, input.workspaceId, { identityId: input.identityId }),
      );
      return BrowserRevisionListResponse.parse({ identity: identityFromRow(identity), revisions });
    },
    CONSISTENT_READ,
  );
}

export async function createBrowserIdentity(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    name: string;
    actorSubjectId: string;
  },
): Promise<BrowserIdentityMutationResponseValue> {
  const name = input.name.trim();
  if (!name || Buffer.byteLength(name) > 200) {
    throw new BrowserIdentityStateError("BrowserIdentity name is invalid");
  }
  return await withRlsContext(db, input, async (scopedDb) => {
    try {
      return await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const id = randomUUID();
        const [inserted] = await tx
          .insert(schema.browserIdentities)
          .values({
            id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            name,
            createOperationId: input.operationId,
            createdBySubjectId: input.actorSubjectId,
          })
          .onConflictDoNothing({
            target: [
              schema.browserIdentities.workspaceId,
              schema.browserIdentities.createOperationId,
            ],
          })
          .returning();
        const row =
          inserted ??
          (
            await tx
              .select()
              .from(schema.browserIdentities)
              .where(
                and(
                  eq(schema.browserIdentities.workspaceId, input.workspaceId),
                  eq(schema.browserIdentities.createOperationId, input.operationId),
                ),
              )
              .limit(1)
          )[0];
        if (!row) throw new Error("BrowserIdentity create operation was lost");
        const replayed = inserted === undefined;
        if (row.name !== name || row.createdBySubjectId !== input.actorSubjectId) {
          throw new BrowserIdentityConflictError(
            "BrowserIdentity operation id is already bound to another request",
          );
        }
        if (!replayed) {
          await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        }
        return BrowserIdentityMutationResponse.parse({
          identity: identityFromRow(row),
          operationId: input.operationId,
          replayed,
        });
      });
    } catch (error) {
      if (postgresConstraint(error) === "browser_identities_workspace_active_name_uq") {
        throw new BrowserIdentityConflictError("An active browser profile already uses this name");
      }
      throw error;
    }
  });
}

export function browserRevisionPublicationRequestDigest(input: {
  browserSessionId: string;
  identityId: string;
  expectedHeadGeneration: number;
  advanceDefault: boolean;
  actorSubjectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        browserSessionId: input.browserSessionId,
        identityId: input.identityId,
        expectedHeadGeneration: input.expectedHeadGeneration,
        advanceDefault: input.advanceDefault,
        actorSubjectId: input.actorSubjectId,
      }),
    )
    .digest("hex");
}

export async function prepareBrowserRevisionPublication(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    identityId: string;
    expectedHeadGeneration: number;
    advanceDefault: boolean;
    actorSubjectId: string;
  },
): Promise<BrowserRevisionPublicationPreparation> {
  const digest = browserRevisionPublicationRequestDigest(input);
  try {
    return await withRlsContext(
      db,
      input,
      async (scopedDb) =>
        await scopedDb.transaction(async (txRaw) => {
          const tx = txRaw as unknown as Database;

          // Resolve a terminal idempotency replay before consulting mutable
          // session/identity state. Ending a session cannot invalidate its
          // already-completed publication receipt.
          const existing = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
          if (existing) {
            assertPublicationOperation(existing, input.browserSessionId, digest);
            if (existing.state === "completed") {
              const response = await loadPublicationResponse(
                tx,
                input.workspaceId,
                input.operationId,
                true,
              );
              if (!response) throw new Error("Completed publication has no BrowserRevision");
              return { kind: "completed", response };
            }
            if (existing.state === "failed" || existing.state === "outcome_unknown") {
              throw new BrowserIdentityStateError(
                existing.errorMessage ?? "BrowserRevision publication did not complete",
              );
            }
          }

          // Every operation that competes for a BrowserSession first locks the
          // resource row. Dispatch, settlement, and end therefore cannot form
          // an operation-row/resource-row lock cycle.
          await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
          const session = await loadBrowserSessionRow(
            tx,
            input.workspaceId,
            input.browserSessionId,
          );
          let operation = existing;
          if (operation) {
            await lockInteractionOperation(tx, input.workspaceId, input.operationId);
            operation = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
            assertPublicationOperation(operation, input.browserSessionId, digest);
            if (operation.state === "completed") {
              const response = await loadPublicationResponse(
                tx,
                input.workspaceId,
                input.operationId,
                true,
              );
              if (!response) throw new Error("Completed publication has no BrowserRevision");
              return { kind: "completed", response };
            }
            if (operation.state === "failed" || operation.state === "outcome_unknown") {
              throw new BrowserIdentityStateError(
                operation.errorMessage ?? "BrowserRevision publication did not complete",
              );
            }
          }
          if (!session) throw new BrowserIdentityNotFoundError("BrowserSession not found");
          if (session.lifecycle !== "active" || !session.controllerGeneration) {
            throw new BrowserIdentityStateError("BrowserSession is not active");
          }
          if (!BrowserSessionCapabilities.parse(session.capabilities).identityPublication) {
            throw new BrowserIdentityStateError(
              "BrowserSession does not support reusable profile publication",
            );
          }
          const identity = await loadIdentity(tx, input.workspaceId, input.identityId);
          if (!identity) throw new BrowserIdentityNotFoundError("BrowserIdentity not found");
          if (identity.status !== "active") {
            throw new BrowserIdentityStateError("BrowserIdentity is archived");
          }
          if (!operation) {
            const [inserted] = await tx
              .insert(schema.interactionOperations)
              .values({
                operationId: input.operationId,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                resourceKind: "browser_session",
                resourceId: input.browserSessionId,
                kind: "publish",
                requestDigest: digest,
                actorSubjectId: input.actorSubjectId,
              })
              .onConflictDoNothing({ target: schema.interactionOperations.operationId })
              .returning();
            operation =
              inserted ??
              (await loadInteractionOperation(tx, input.workspaceId, input.operationId));
          }
          if (!operation) {
            throw new BrowserIdentityConflictError(
              "Publication operation id belongs to another workspace",
            );
          }
          assertPublicationOperation(operation, input.browserSessionId, digest);
          if (
            operation.controllerGeneration &&
            operation.controllerGeneration !== session.controllerGeneration
          ) {
            throw new BrowserIdentityConflictError("Publication belongs to a stale controller");
          }
          if (operation.state !== "prepared" && operation.state !== "dispatched") {
            throw new BrowserIdentityStateError(
              "BrowserRevision publication has an invalid active state",
            );
          }
          return {
            kind: "pending",
            operationState: operation.state,
            browserSessionId: session.id,
            controllerGeneration: session.controllerGeneration,
            identity: identityFromRow(identity),
            parentRevisionId:
              session.identityId === input.identityId ? session.baseRevisionId : null,
          };
        }),
    );
  } catch (error) {
    if (postgresConstraint(error) === "interaction_operations_active_resource_uq") {
      throw new BrowserIdentityConflictError(
        "BrowserSession already has an active lifecycle operation",
      );
    }
    throw error;
  }
}

export async function dispatchBrowserRevisionPublication(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
    identityId: string;
    expectedHeadGeneration: number;
    advanceDefault: boolean;
    actorSubjectId: string;
  },
): Promise<BrowserRevisionPublicationDispatch> {
  const digest = browserRevisionPublicationRequestDigest(input);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const beforeLock = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
        assertPublicationOperation(beforeLock, input.browserSessionId, digest);
        if (beforeLock.state === "completed") {
          const response = await loadPublicationResponse(
            tx,
            input.workspaceId,
            input.operationId,
            true,
          );
          if (!response) throw new Error("Completed publication has no BrowserRevision");
          return { kind: "completed", response };
        }
        if (beforeLock.state === "failed" || beforeLock.state === "outcome_unknown") {
          throw new BrowserIdentityStateError(
            beforeLock.errorMessage ?? "BrowserRevision publication did not complete",
          );
        }

        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const session = await loadBrowserSessionRow(tx, input.workspaceId, input.browserSessionId);
        await lockInteractionOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
        assertPublicationOperation(operation, input.browserSessionId, digest);
        if (operation.state === "completed") {
          const response = await loadPublicationResponse(
            tx,
            input.workspaceId,
            input.operationId,
            true,
          );
          if (!response) throw new Error("Completed publication has no BrowserRevision");
          return { kind: "completed", response };
        }
        if (operation.state === "failed" || operation.state === "outcome_unknown") {
          throw new BrowserIdentityStateError(
            operation.errorMessage ?? "BrowserRevision publication did not complete",
          );
        }
        if (
          !session ||
          session.lifecycle !== "active" ||
          session.controllerGeneration !== input.controllerGeneration
        ) {
          throw new BrowserIdentityConflictError(
            "BrowserRevision publication has a stale BrowserSession controller",
          );
        }
        if (operation.state === "dispatched") {
          if (operation.controllerGeneration !== input.controllerGeneration) {
            throw new BrowserIdentityConflictError(
              "Publication belongs to another controller generation",
            );
          }
          return {
            kind: "dispatched",
            browserSessionId: input.browserSessionId,
            controllerGeneration: input.controllerGeneration,
            replayed: true,
          };
        }

        const now = new Date();
        const [updated] = await tx
          .update(schema.interactionOperations)
          .set({
            state: "dispatched",
            controllerGeneration: input.controllerGeneration,
            dispatchedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.interactionOperations.workspaceId, input.workspaceId),
              eq(schema.interactionOperations.operationId, input.operationId),
              eq(schema.interactionOperations.state, "prepared"),
            ),
          )
          .returning({ operationId: schema.interactionOperations.operationId });
        if (!updated) throw new Error("BrowserRevision publication dispatch was lost");
        return {
          kind: "dispatched",
          browserSessionId: input.browserSessionId,
          controllerGeneration: input.controllerGeneration,
          replayed: false,
        };
      }),
  );
}

export async function commitBrowserRevisionPublication(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
    identityId: string;
    expectedHeadGeneration: number;
    advanceDefault: boolean;
    actorSubjectId: string;
    manifestDigest: string;
    artifacts: readonly BrowserStateArtifactCommitInput[];
  },
): Promise<PublishBrowserRevisionResponseValue> {
  const digest = browserRevisionPublicationRequestDigest(input);
  const artifacts = validateArtifacts(input.workspaceId, input.artifacts);
  if (!SHA256_PATTERN.test(input.manifestDigest)) {
    throw new BrowserIdentityStateError("BrowserRevision manifest digest is invalid");
  }
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const beforeLock = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
        assertPublicationOperation(beforeLock, input.browserSessionId, digest);
        if (beforeLock.state === "completed") {
          const replayed = await loadPublicationResponse(
            tx,
            input.workspaceId,
            input.operationId,
            true,
          );
          if (!replayed) throw new Error("Completed publication has no BrowserRevision");
          return replayed;
        }
        if (beforeLock.state === "failed" || beforeLock.state === "outcome_unknown") {
          throw new BrowserIdentityStateError(
            beforeLock.errorMessage ?? "BrowserRevision publication did not complete",
          );
        }

        await lockBrowserSession(tx, input.workspaceId, input.browserSessionId);
        const session = await loadBrowserSessionRow(tx, input.workspaceId, input.browserSessionId);
        await lockInteractionOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
        assertPublicationOperation(operation, input.browserSessionId, digest);
        if (operation.state === "completed") {
          const replayed = await loadPublicationResponse(
            tx,
            input.workspaceId,
            input.operationId,
            true,
          );
          if (!replayed) throw new Error("Completed publication has no BrowserRevision");
          return replayed;
        }
        if (operation.state === "failed" || operation.state === "outcome_unknown") {
          throw new BrowserIdentityStateError(
            operation.errorMessage ?? "BrowserRevision publication did not complete",
          );
        }
        if (
          !session ||
          session.lifecycle !== "active" ||
          session.controllerGeneration !== input.controllerGeneration
        ) {
          throw new BrowserIdentityStateError("BrowserSession controller is no longer active");
        }
        if (operation.state !== "dispatched") {
          throw new BrowserIdentityStateError("BrowserRevision publication is not dispatched");
        }
        if (operation.controllerGeneration !== input.controllerGeneration) {
          throw new BrowserIdentityConflictError("Publication controller generation changed");
        }

        await lockBrowserIdentity(tx, input.workspaceId, input.identityId);
        const identity = await loadIdentity(tx, input.workspaceId, input.identityId);
        if (!identity) throw new BrowserIdentityNotFoundError("BrowserIdentity not found");
        if (identity.status !== "active") {
          throw new BrowserIdentityStateError("BrowserIdentity is archived");
        }

        const now = new Date();
        const revisionId = randomUUID();
        const ordinal = safeInteger(identity.revisionCount + 1, "next BrowserRevision ordinal");
        const parentRevisionId =
          session.identityId === input.identityId ? session.baseRevisionId : null;
        const defaultAdvanced =
          input.advanceDefault && identity.headGeneration === input.expectedHeadGeneration;
        const resultHeadGeneration = defaultAdvanced
          ? safeInteger(identity.headGeneration + 1, "next BrowserIdentity head generation")
          : identity.headGeneration;

        const artifactRows: BrowserStateArtifactRow[] = [];
        for (const artifact of artifacts) {
          const [row] = await tx
            .insert(schema.browserStateArtifacts)
            .values({
              id: randomUUID(),
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sourceBrowserSessionId: input.browserSessionId,
              purpose: "revision_component",
              ...artifact,
            })
            .returning();
          if (!row) throw new Error("Browser state artifact insert was lost");
          artifactRows.push(row);
        }

        const [revisionRow] = await tx
          .insert(schema.browserRevisions)
          .values({
            id: revisionId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            identityId: input.identityId,
            parentRevisionId,
            ordinal,
            sourceBrowserSessionId: input.browserSessionId,
            publicationOperationId: input.operationId,
            expectedHeadGeneration: input.expectedHeadGeneration,
            advanceDefaultRequested: input.advanceDefault,
            defaultAdvanced,
            resultHeadGeneration,
            manifestDigest: input.manifestDigest,
            createdBySubjectId: input.actorSubjectId,
            createdAt: now,
          })
          .returning();
        if (!revisionRow) throw new Error("BrowserRevision insert was lost");

        const componentRows: BrowserRevisionComponentRow[] = [];
        for (const [position, artifact] of artifactRows.entries()) {
          const [component] = await tx
            .insert(schema.browserRevisionComponents)
            .values({
              id: randomUUID(),
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              identityId: input.identityId,
              revisionId,
              artifactId: artifact.id,
              sourceBrowserSessionId: input.browserSessionId,
              artifactPurpose: "revision_component",
              kind: artifact.kind,
              position,
              createdAt: now,
            })
            .returning();
          if (!component) throw new Error("BrowserRevision component insert was lost");
          componentRows.push(component);
        }

        const [identityRow] = await tx
          .update(schema.browserIdentities)
          .set({
            revisionCount: ordinal,
            ...(defaultAdvanced
              ? { defaultRevisionId: revisionId, headGeneration: resultHeadGeneration }
              : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserIdentities.workspaceId, input.workspaceId),
              eq(schema.browserIdentities.id, input.identityId),
            ),
          )
          .returning();
        if (!identityRow) throw new Error("BrowserIdentity publication update was lost");

        if (session.privateCheckpointArtifactId) {
          const [retired] = await tx
            .update(schema.browserStateArtifacts)
            .set({ state: "delete_pending", retainedUntil: now })
            .where(
              and(
                eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
                eq(schema.browserStateArtifacts.id, session.privateCheckpointArtifactId),
                eq(schema.browserStateArtifacts.sourceBrowserSessionId, input.browserSessionId),
                eq(schema.browserStateArtifacts.purpose, "private_checkpoint"),
                eq(schema.browserStateArtifacts.state, "available"),
              ),
            )
            .returning({ id: schema.browserStateArtifacts.id });
          if (!retired) {
            throw new BrowserIdentityStateError(
              "BrowserSession private checkpoint authority is inconsistent",
            );
          }
        }

        const [sessionRow] = await tx
          .update(schema.browserSessions)
          .set({
            identityId: input.identityId,
            baseRevisionId: revisionId,
            privateCheckpointArtifactId: null,
            lastUsedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
              eq(schema.browserSessions.controllerGeneration, input.controllerGeneration),
              eq(schema.browserSessions.lifecycle, "active"),
            ),
          )
          .returning({ id: schema.browserSessions.id });
        if (!sessionRow)
          throw new BrowserIdentityStateError("BrowserSession publication fence changed");

        const [settled] = await tx
          .update(schema.interactionOperations)
          .set({ state: "completed", settledAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.interactionOperations.workspaceId, input.workspaceId),
              eq(schema.interactionOperations.operationId, input.operationId),
              eq(schema.interactionOperations.state, "dispatched"),
            ),
          )
          .returning({ operationId: schema.interactionOperations.operationId });
        if (!settled) throw new Error("BrowserRevision publication settlement was lost");
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);

        const artifactMap = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
        return PublishBrowserRevisionResponse.parse({
          identity: identityFromRow(identityRow),
          revision: revisionFromRows(revisionRow, componentRows, artifactMap),
          outcome: defaultAdvanced ? "saved_as_default" : "saved_not_default",
          replayed: false,
        });
      }),
  );
}

export async function failBrowserRevisionPublication(
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
): Promise<void> {
  const error = InteractionError.parse(input.error);
  await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockInteractionOperation(tx, input.workspaceId, input.operationId);
        const operation = await loadInteractionOperation(tx, input.workspaceId, input.operationId);
        if (!operation) throw new BrowserIdentityNotFoundError("Publication operation not found");
        if (
          operation.resourceKind !== "browser_session" ||
          operation.resourceId !== input.browserSessionId ||
          operation.kind !== "publish"
        ) {
          throw new BrowserIdentityConflictError("Operation belongs to another resource");
        }
        if (
          operation.state === "completed" ||
          operation.state === "failed" ||
          operation.state === "outcome_unknown"
        ) {
          return;
        }
        if (
          operation.state !== "dispatched" ||
          operation.controllerGeneration !== input.controllerGeneration
        ) {
          throw new BrowserIdentityConflictError(
            "Publication failure belongs to another controller generation",
          );
        }
        const state = input.state ?? "failed";
        const now = new Date();
        const [settled] = await tx
          .update(schema.interactionOperations)
          .set({
            state,
            errorCode: error.code,
            errorMessage: error.message,
            errorRetryable: error.retryable,
            errorDetails: error.details ?? null,
            settledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.interactionOperations.workspaceId, input.workspaceId),
              eq(schema.interactionOperations.operationId, input.operationId),
              eq(schema.interactionOperations.state, "dispatched"),
              eq(schema.interactionOperations.controllerGeneration, input.controllerGeneration),
            ),
          )
          .returning({ operationId: schema.interactionOperations.operationId });
        if (!settled) throw new Error("BrowserRevision publication failure settlement was lost");
      }),
  );
}

/** Server-only storage authority used to restore a revision. Never project this
 *  result through HTTP, MCP, Codemode output, or the public SDK. */
export async function getBrowserRevisionArtifactAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    identityId: string;
    revisionId: string;
  },
): Promise<BrowserRevisionArtifactAuthority> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await loadBrowserRevisionArtifactAuthority(scopedDb, {
        workspaceId: input.workspaceId,
        identityId: input.identityId,
        revisionId: input.revisionId,
      }),
    CONSISTENT_READ,
  );
}

async function loadBrowserRevisionArtifactAuthority(
  db: Database,
  input: { workspaceId: string; identityId: string; revisionId: string },
): Promise<BrowserRevisionArtifactAuthority> {
  const rows = await loadRevisionRows(db, input.workspaceId, {
    identityId: input.identityId,
    revisionId: input.revisionId,
  });
  const row = rows[0];
  if (!row) throw new BrowserIdentityNotFoundError("BrowserRevision not found");
  const components = await db
    .select()
    .from(schema.browserRevisionComponents)
    .where(eq(schema.browserRevisionComponents.revisionId, row.id))
    .orderBy(asc(schema.browserRevisionComponents.position));
  if (components.length === 0) {
    throw new BrowserIdentityStateError("BrowserRevision has no state components");
  }
  const artifacts = await db
    .select()
    .from(schema.browserStateArtifacts)
    .where(
      inArray(
        schema.browserStateArtifacts.id,
        components.map((component) => component.artifactId),
      ),
    );
  const byArtifact = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const revision = revisionFromRows(row, components, byArtifact);
  return {
    revision,
    artifacts: components.map((component) => {
      const artifact = byArtifact.get(component.artifactId);
      if (!artifact || artifact.state !== "available") {
        throw new BrowserIdentityStateError("BrowserRevision artifact is unavailable");
      }
      return {
        componentId: component.id,
        artifactId: artifact.id,
        objectKey: artifact.objectKey,
        encryptedDataKey: artifact.encryptedDataKey,
        contentDigest: artifact.contentDigest,
        manifestDigest: artifact.manifestDigest,
        artifactDigest: artifact.artifactDigest,
        sizeBytes: safeInteger(artifact.sizeBytes, "browser artifact size"),
        format: artifact.format,
        materialization: BrowserRevisionMaterialization.parse(artifact.materialization),
      };
    }),
  };
}

function validateArtifacts(
  workspaceId: string,
  values: readonly BrowserStateArtifactCommitInput[],
): BrowserStateArtifactCommitInput[] {
  if (values.length < 1 || values.length > MAX_COMPONENTS) {
    throw new BrowserIdentityStateError("BrowserRevision component count is invalid");
  }
  const seenKinds = new Set<BrowserStateArtifactCommitInput["kind"]>();
  return values.map((value) => {
    let validated: BrowserStateArtifactCommitInput;
    try {
      validated = validateBrowserStateArtifactCommitInput(workspaceId, value);
    } catch (error) {
      throw new BrowserIdentityStateError(
        error instanceof Error ? error.message : "BrowserRevision artifact metadata is invalid",
      );
    }
    if (seenKinds.has(value.kind)) {
      throw new BrowserIdentityStateError("BrowserRevision component kinds must be unique");
    }
    seenKinds.add(value.kind);
    return validated;
  });
}

async function loadBrowserSessionRow(
  db: Database,
  workspaceId: string,
  browserSessionId: string,
): Promise<BrowserSessionRow | null> {
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
  return row ?? null;
}

async function loadInteractionOperation(
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

function assertPublicationOperation(
  operation: InteractionOperationRow | null,
  browserSessionId: string,
  digest: string,
): asserts operation is InteractionOperationRow {
  if (!operation) throw new BrowserIdentityNotFoundError("Publication operation not found");
  if (
    operation.resourceKind !== "browser_session" ||
    operation.resourceId !== browserSessionId ||
    operation.kind !== "publish" ||
    operation.requestDigest !== digest
  ) {
    throw new BrowserIdentityConflictError(
      "Publication operation id is already bound to another request",
    );
  }
}

async function lockBrowserIdentity(db: Database, workspaceId: string, identityId: string) {
  await db.execute(sql`
    select id from browser_identities
    where workspace_id = ${workspaceId} and id = ${identityId}
    for update
  `);
}

async function lockBrowserSession(db: Database, workspaceId: string, browserSessionId: string) {
  await db.execute(sql`
    select id from browser_sessions
    where workspace_id = ${workspaceId} and id = ${browserSessionId}
    for update
  `);
}

async function lockInteractionOperation(db: Database, workspaceId: string, operationId: string) {
  await db.execute(sql`
    select operation_id from interaction_operations
    where workspace_id = ${workspaceId} and operation_id = ${operationId}
    for update
  `);
}

function postgresConstraint(error: unknown): string | null {
  return safeDatabaseErrorFacts(error).constraint ?? null;
}
