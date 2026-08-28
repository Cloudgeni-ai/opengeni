import { createHash } from "node:crypto";

import {
  CreateInternalApplicationRequest,
  ApproveInternalApplicationDeploymentRequest,
  InternalApplicationBundle,
  InternalApplicationDataSource,
  InternalApplicationDefinition,
  InternalApplicationDeployment,
  InternalApplicationEvent,
  InternalApplicationDeploymentOperation,
  InternalApplicationDeploymentTarget,
  InternalApplicationDetail,
  InternalApplicationRevision,
  InternalApplicationSummary,
  RegisterInternalApplicationBundleRequest,
  PlanInternalApplicationDeploymentRequest,
  UpdateInternalApplicationRequest,
  UpsertInternalApplicationDataSourceRequest,
  UpsertInternalApplicationDeploymentTargetRequest,
  stableJson,
  type InternalApplicationDeploymentPlan,
} from "@opengeni/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { type Database, withWorkspaceRls } from "./database";
import * as schema from "./schema";

export class InternalApplicationNotFoundError extends Error {
  readonly name = "InternalApplicationNotFoundError";
}

export class InternalApplicationVersionConflictError extends Error {
  readonly name = "InternalApplicationVersionConflictError";
}

export class InternalApplicationIdempotencyError extends Error {
  readonly name = "InternalApplicationIdempotencyError";
}

export class InternalApplicationInvariantError extends Error {
  readonly name = "InternalApplicationInvariantError";
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function iso(value: Date): string {
  return value.toISOString();
}

type ApplicationRow = typeof schema.internalApplications.$inferSelect;
type RevisionRow = typeof schema.internalApplicationRevisions.$inferSelect;
type DataSourceRow = typeof schema.internalApplicationDataSources.$inferSelect;
type TargetRow = typeof schema.internalApplicationDeploymentTargets.$inferSelect;
type BundleRow = typeof schema.internalApplicationBundles.$inferSelect;
type DeploymentRow = typeof schema.internalApplicationDeployments.$inferSelect;
type OperationRow = typeof schema.internalApplicationDeploymentOperations.$inferSelect;
type EventRow = typeof schema.internalApplicationEvents.$inferSelect;

function applicationSummary(row: ApplicationRow) {
  if (!row.headRevisionId || !row.definitionHash || row.headRevision < 1) {
    throw new InternalApplicationInvariantError("Application has no durable head revision");
  }
  return InternalApplicationSummary.parse({
    schemaVersion: 1,
    runtimeKind: "external_deployment",
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    headRevisionId: row.headRevisionId,
    headRevision: row.headRevision,
    definitionHash: row.definitionHash,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function revision(row: RevisionRow) {
  return InternalApplicationRevision.parse({
    schemaVersion: 1,
    runtimeKind: "external_deployment",
    id: row.id,
    applicationId: row.applicationId,
    revision: row.revision,
    definitionHash: row.definitionHash,
    definition: row.definition,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  });
}

function dataSource(row: DataSourceRow) {
  return InternalApplicationDataSource.parse({
    schemaVersion: 1,
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    kind: row.kind,
    allowedAccessModes: row.allowedAccessModes,
    locator: row.locator,
    schemaDefinition: row.schemaDefinition,
    governance: row.governance,
    metadata: row.metadata,
    status: row.status,
    revision: row.revision,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function target(row: TargetRow) {
  return InternalApplicationDeploymentTarget.parse({
    schemaVersion: 1,
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    kind: row.kind,
    environment: row.environment,
    site: row.site,
    config: row.config,
    capabilities: row.capabilities,
    metadata: row.metadata,
    status: row.status,
    revision: row.revision,
    lastObservedAt: row.lastObservedAt ? iso(row.lastObservedAt) : null,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function bundle(row: BundleRow) {
  return InternalApplicationBundle.parse({
    schemaVersion: 1,
    id: row.id,
    applicationId: row.applicationId,
    applicationRevisionId: row.applicationRevisionId,
    digest: row.digest,
    manifest: row.manifest,
    status: row.status,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  });
}

export function projectInternalApplicationDeployment(row: DeploymentRow) {
  return InternalApplicationDeployment.parse({
    schemaVersion: 1,
    id: row.id,
    applicationId: row.applicationId,
    environment: row.environment,
    targetId: row.targetId,
    targetRevision: row.targetRevision,
    activeBundleId: row.activeBundleId,
    desiredBundleId: row.desiredBundleId,
    status: row.status,
    internalUrl: row.internalUrl,
    revision: row.revision,
    lastObservedAt: row.lastObservedAt ? iso(row.lastObservedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export function projectInternalApplicationOperation(row: OperationRow) {
  return InternalApplicationDeploymentOperation.parse({
    schemaVersion: 1,
    id: row.id,
    deploymentId: row.deploymentId,
    kind: row.kind,
    status: row.status,
    requestHash: row.requestHash,
    plan: row.plan,
    approvedBySubjectId: row.approvedBySubjectId,
    approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export function projectInternalApplicationEvent(row: EventRow) {
  return InternalApplicationEvent.parse({
    schemaVersion: 1,
    id: row.id,
    applicationId: row.applicationId,
    deploymentId: row.deploymentId,
    operationId: row.operationId,
    type: row.type,
    actorSubjectId: row.actorSubjectId,
    facts: row.facts,
    createdAt: iso(row.createdAt),
  });
}

async function workspaceAccountId(db: Database, workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ accountId: schema.workspaces.accountId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!row) throw new InternalApplicationNotFoundError("Workspace was not found");
  return row.accountId;
}

async function detailInScope(db: Database, workspaceId: string, applicationId: string) {
  const [app] = await db
    .select()
    .from(schema.internalApplications)
    .where(
      and(
        eq(schema.internalApplications.workspaceId, workspaceId),
        eq(schema.internalApplications.id, applicationId),
      ),
    )
    .limit(1);
  if (!app?.headRevisionId) throw new InternalApplicationNotFoundError("Application was not found");
  const [head] = await db
    .select()
    .from(schema.internalApplicationRevisions)
    .where(eq(schema.internalApplicationRevisions.id, app.headRevisionId))
    .limit(1);
  if (!head) throw new InternalApplicationInvariantError("Application head revision was not found");
  return InternalApplicationDetail.parse({
    application: applicationSummary(app),
    headRevision: revision(head),
  });
}

export async function listInternalApplications(db: Database, workspaceId: string) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.internalApplications)
      .where(eq(schema.internalApplications.workspaceId, workspaceId))
      .orderBy(desc(schema.internalApplications.updatedAt), asc(schema.internalApplications.id))
      .limit(500);
    return rows.map(applicationSummary);
  });
}

export async function getInternalApplication(
  db: Database,
  workspaceId: string,
  applicationId: string,
) {
  return await withWorkspaceRls(db, workspaceId, (scoped) =>
    detailInScope(scoped, workspaceId, applicationId),
  );
}

export async function createInternalApplication(
  db: Database,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    request: CreateInternalApplicationRequest;
  },
) {
  const request = CreateInternalApplicationRequest.parse(input.request);
  const requestHash = hash(request);
  const definition = InternalApplicationDefinition.parse(request.definition);
  const definitionHash = hash(definition);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`internal-applications:${input.workspaceId}`}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(schema.internalApplications)
          .where(
            and(
              eq(schema.internalApplications.workspaceId, input.workspaceId),
              eq(schema.internalApplications.creationOperationId, request.operationId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.creationRequestHash !== requestHash) {
            throw new InternalApplicationIdempotencyError(
              "Operation id was reused with a different request",
            );
          }
          return await detailInScope(tx, input.workspaceId, existing.id);
        }
        const accountId = await workspaceAccountId(tx, input.workspaceId);
        const applicationId = crypto.randomUUID();
        const revisionId = crypto.randomUUID();
        await tx.insert(schema.internalApplications).values({
          id: applicationId,
          accountId,
          workspaceId: input.workspaceId,
          slug: request.slug,
          name: request.name,
          description: request.description,
          status: "draft",
          creationOperationId: request.operationId,
          creationRequestHash: requestHash,
          createdBySubjectId: input.actorSubjectId,
        });
        await tx.insert(schema.internalApplicationRevisions).values({
          id: revisionId,
          accountId,
          workspaceId: input.workspaceId,
          applicationId,
          operationId: request.operationId,
          requestHash,
          revision: 1,
          definitionHash,
          definition,
          createdBySubjectId: input.actorSubjectId,
        });
        await tx
          .update(schema.internalApplications)
          .set({
            headRevisionId: revisionId,
            headRevision: 1,
            definitionHash,
            updatedAt: new Date(),
          })
          .where(eq(schema.internalApplications.id, applicationId));
        await tx.insert(schema.internalApplicationEvents).values({
          accountId,
          workspaceId: input.workspaceId,
          applicationId,
          type: "application.created",
          actorSubjectId: input.actorSubjectId,
          facts: { revision: 1, definitionHash },
        });
        return await detailInScope(tx, input.workspaceId, applicationId);
      }),
  );
}

export async function updateInternalApplication(
  db: Database,
  input: {
    workspaceId: string;
    applicationId: string;
    actorSubjectId: string;
    request: UpdateInternalApplicationRequest;
  },
) {
  const request = UpdateInternalApplicationRequest.parse(input.request);
  const requestHash = hash(request);
  const definition = InternalApplicationDefinition.parse(request.definition);
  const definitionHash = hash(definition);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [app] = await tx
          .select()
          .from(schema.internalApplications)
          .where(
            and(
              eq(schema.internalApplications.workspaceId, input.workspaceId),
              eq(schema.internalApplications.id, input.applicationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!app) throw new InternalApplicationNotFoundError("Application was not found");
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationRevisions)
          .where(
            and(
              eq(schema.internalApplicationRevisions.applicationId, input.applicationId),
              eq(schema.internalApplicationRevisions.operationId, request.operationId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new InternalApplicationIdempotencyError(
              "Operation id was reused with a different request",
            );
          }
          return await detailInScope(tx, input.workspaceId, input.applicationId);
        }
        if (app.headRevision !== request.expectedHeadRevision) {
          throw new InternalApplicationVersionConflictError("Application head revision changed");
        }
        const nextRevision = app.headRevision + 1;
        const revisionId = crypto.randomUUID();
        await tx.insert(schema.internalApplicationRevisions).values({
          id: revisionId,
          accountId: app.accountId,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          operationId: request.operationId,
          requestHash,
          revision: nextRevision,
          definitionHash,
          definition,
          createdBySubjectId: input.actorSubjectId,
        });
        await tx
          .update(schema.internalApplications)
          .set({
            name: request.name,
            description: request.description,
            status: request.status,
            headRevisionId: revisionId,
            headRevision: nextRevision,
            definitionHash,
            updatedAt: new Date(),
          })
          .where(eq(schema.internalApplications.id, input.applicationId));
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: app.accountId,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          type: "application.revised",
          actorSubjectId: input.actorSubjectId,
          facts: {
            revision: nextRevision,
            definitionHash,
            status: request.status,
          },
        });
        return await detailInScope(tx, input.workspaceId, input.applicationId);
      }),
  );
}

export async function listInternalApplicationDataSources(db: Database, workspaceId: string) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.internalApplicationDataSources)
        .where(eq(schema.internalApplicationDataSources.workspaceId, workspaceId))
        .orderBy(asc(schema.internalApplicationDataSources.name))
        .limit(500)
    ).map(dataSource),
  );
}

export async function upsertInternalApplicationDataSource(
  db: Database,
  input: {
    workspaceId: string;
    dataSourceId: string;
    actorSubjectId: string;
    request: UpsertInternalApplicationDataSourceRequest;
  },
) {
  const request = UpsertInternalApplicationDataSourceRequest.parse(input.request);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationDataSources)
          .where(
            and(
              eq(schema.internalApplicationDataSources.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDataSources.id, input.dataSourceId),
            ),
          )
          .for("update")
          .limit(1);
        if (!existing) {
          if (request.expectedRevision !== 0) {
            throw new InternalApplicationVersionConflictError(
              "Data source does not exist at that revision",
            );
          }
          const accountId = await workspaceAccountId(tx, input.workspaceId);
          const [created] = await tx
            .insert(schema.internalApplicationDataSources)
            .values({
              id: input.dataSourceId,
              accountId,
              workspaceId: input.workspaceId,
              name: request.name,
              description: request.description,
              kind: request.kind,
              allowedAccessModes: request.allowedAccessModes,
              locator: request.locator,
              schemaDefinition: request.schemaDefinition,
              governance: request.governance,
              metadata: request.metadata,
              status: request.status,
              createdBySubjectId: input.actorSubjectId,
            })
            .returning();
          if (!created)
            throw new InternalApplicationInvariantError("Data source insert returned no row");
          return dataSource(created);
        }
        if (request.expectedRevision !== existing.revision) {
          throw new InternalApplicationVersionConflictError("Data source revision changed");
        }
        const [updated] = await tx
          .update(schema.internalApplicationDataSources)
          .set({
            name: request.name,
            description: request.description,
            kind: request.kind,
            allowedAccessModes: request.allowedAccessModes,
            locator: request.locator,
            schemaDefinition: request.schemaDefinition,
            governance: request.governance,
            metadata: request.metadata,
            status: request.status,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.internalApplicationDataSources.id, existing.id))
          .returning();
        if (!updated)
          throw new InternalApplicationInvariantError("Data source update returned no row");
        return dataSource(updated);
      }),
  );
}

export async function listInternalApplicationDeploymentTargets(db: Database, workspaceId: string) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.internalApplicationDeploymentTargets)
        .where(eq(schema.internalApplicationDeploymentTargets.workspaceId, workspaceId))
        .orderBy(asc(schema.internalApplicationDeploymentTargets.name))
        .limit(500)
    ).map(target),
  );
}

export async function upsertInternalApplicationDeploymentTarget(
  db: Database,
  input: {
    workspaceId: string;
    targetId: string;
    actorSubjectId: string;
    request: UpsertInternalApplicationDeploymentTargetRequest;
  },
) {
  const request = UpsertInternalApplicationDeploymentTargetRequest.parse(input.request);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationDeploymentTargets)
          .where(
            and(
              eq(schema.internalApplicationDeploymentTargets.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentTargets.id, input.targetId),
            ),
          )
          .for("update")
          .limit(1);
        if (!existing) {
          if (request.expectedRevision !== 0) {
            throw new InternalApplicationVersionConflictError(
              "Deployment target does not exist at that revision",
            );
          }
          const accountId = await workspaceAccountId(tx, input.workspaceId);
          const [created] = await tx
            .insert(schema.internalApplicationDeploymentTargets)
            .values({
              id: input.targetId,
              accountId,
              workspaceId: input.workspaceId,
              name: request.name,
              description: request.description,
              kind: request.kind,
              environment: request.environment,
              site: request.site,
              config: request.config,
              capabilities: request.capabilities,
              metadata: request.metadata,
              status: request.status,
              createdBySubjectId: input.actorSubjectId,
            })
            .returning();
          if (!created)
            throw new InternalApplicationInvariantError("Target insert returned no row");
          return target(created);
        }
        if (request.expectedRevision !== existing.revision) {
          throw new InternalApplicationVersionConflictError("Deployment target revision changed");
        }
        const [updated] = await tx
          .update(schema.internalApplicationDeploymentTargets)
          .set({
            name: request.name,
            description: request.description,
            kind: request.kind,
            environment: request.environment,
            site: request.site,
            config: request.config,
            capabilities: request.capabilities,
            metadata: request.metadata,
            status: request.status,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.internalApplicationDeploymentTargets.id, existing.id))
          .returning();
        if (!updated) throw new InternalApplicationInvariantError("Target update returned no row");
        return target(updated);
      }),
  );
}

export async function registerInternalApplicationBundle(
  db: Database,
  input: {
    workspaceId: string;
    applicationId: string;
    actorSubjectId: string;
    request: RegisterInternalApplicationBundleRequest;
  },
) {
  const request = RegisterInternalApplicationBundleRequest.parse(input.request);
  const requestHash = hash(request);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [app] = await tx
          .select()
          .from(schema.internalApplications)
          .where(
            and(
              eq(schema.internalApplications.workspaceId, input.workspaceId),
              eq(schema.internalApplications.id, input.applicationId),
            ),
          )
          .limit(1);
        if (!app) throw new InternalApplicationNotFoundError("Application was not found");
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationBundles)
          .where(
            and(
              eq(schema.internalApplicationBundles.applicationId, input.applicationId),
              eq(schema.internalApplicationBundles.operationId, request.operationId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new InternalApplicationIdempotencyError(
              "Operation id was reused with a different bundle",
            );
          }
          return bundle(existing);
        }
        const [revisionRow] = await tx
          .select({ id: schema.internalApplicationRevisions.id })
          .from(schema.internalApplicationRevisions)
          .where(
            and(
              eq(schema.internalApplicationRevisions.applicationId, input.applicationId),
              eq(schema.internalApplicationRevisions.id, request.applicationRevisionId),
            ),
          )
          .limit(1);
        if (!revisionRow)
          throw new InternalApplicationNotFoundError("Application revision was not found");
        const [created] = await tx
          .insert(schema.internalApplicationBundles)
          .values({
            accountId: app.accountId,
            workspaceId: input.workspaceId,
            applicationId: input.applicationId,
            applicationRevisionId: request.applicationRevisionId,
            operationId: request.operationId,
            requestHash,
            digest: request.digest,
            manifest: request.manifest,
            status: "ready",
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        if (!created) throw new InternalApplicationInvariantError("Bundle insert returned no row");
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: app.accountId,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          type: "bundle.registered",
          actorSubjectId: input.actorSubjectId,
          facts: { bundleId: created.id, digest: created.digest },
        });
        return bundle(created);
      }),
  );
}

export async function listInternalApplicationBundles(
  db: Database,
  workspaceId: string,
  applicationId: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.internalApplicationBundles)
        .where(
          and(
            eq(schema.internalApplicationBundles.workspaceId, workspaceId),
            eq(schema.internalApplicationBundles.applicationId, applicationId),
          ),
        )
        .orderBy(desc(schema.internalApplicationBundles.createdAt))
        .limit(500)
    ).map(bundle),
  );
}

export async function listInternalApplicationDeployments(
  db: Database,
  workspaceId: string,
  applicationId?: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const condition = applicationId
      ? and(
          eq(schema.internalApplicationDeployments.workspaceId, workspaceId),
          eq(schema.internalApplicationDeployments.applicationId, applicationId),
        )
      : eq(schema.internalApplicationDeployments.workspaceId, workspaceId);
    return (
      await scoped
        .select()
        .from(schema.internalApplicationDeployments)
        .where(condition)
        .orderBy(desc(schema.internalApplicationDeployments.updatedAt))
        .limit(100)
    ).map(projectInternalApplicationDeployment);
  });
}

export type InternalApplicationDeploymentState = {
  deployment: DeploymentRow;
  operation: OperationRow;
};

export async function persistInternalApplicationDeploymentPlan(
  db: Database,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    operationId: string;
    requestHash: string;
    plan: InternalApplicationDeploymentPlan;
  },
): Promise<InternalApplicationDeploymentState> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [existingOperation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentOperations.id, input.operationId),
            ),
          )
          .limit(1);
        if (existingOperation) {
          if (existingOperation.requestHash !== input.requestHash) {
            throw new InternalApplicationIdempotencyError(
              "Operation id was reused with a different plan request",
            );
          }
          const [deployment] = await tx
            .select()
            .from(schema.internalApplicationDeployments)
            .where(eq(schema.internalApplicationDeployments.id, existingOperation.deploymentId))
            .limit(1);
          if (!deployment)
            throw new InternalApplicationInvariantError("Operation deployment disappeared");
          return { deployment, operation: existingOperation };
        }
        const [app] = await tx
          .select()
          .from(schema.internalApplications)
          .where(
            and(
              eq(schema.internalApplications.workspaceId, input.workspaceId),
              eq(schema.internalApplications.id, input.plan.applicationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!app) throw new InternalApplicationNotFoundError("Application was not found");
        if (app.headRevision !== input.plan.applicationRevision) {
          throw new InternalApplicationVersionConflictError(
            "Application revision changed while planning",
          );
        }
        let [deployment] = await tx
          .select()
          .from(schema.internalApplicationDeployments)
          .where(
            and(
              eq(schema.internalApplicationDeployments.applicationId, input.plan.applicationId),
              eq(schema.internalApplicationDeployments.environment, input.plan.environment),
            ),
          )
          .for("update")
          .limit(1);
        if (!deployment) {
          [deployment] = await tx
            .insert(schema.internalApplicationDeployments)
            .values({
              accountId: app.accountId,
              workspaceId: input.workspaceId,
              applicationId: input.plan.applicationId,
              environment: input.plan.environment,
              targetId: input.plan.targetId,
              targetRevision: input.plan.targetRevision,
              desiredBundleId: input.plan.bundleId,
              status: input.plan.destructive ? "awaiting_approval" : "plan_ready",
            })
            .returning();
        } else {
          [deployment] = await tx
            .update(schema.internalApplicationDeployments)
            .set({
              targetId: input.plan.targetId,
              targetRevision: input.plan.targetRevision,
              desiredBundleId: input.plan.bundleId,
              status: input.plan.destructive ? "awaiting_approval" : "plan_ready",
              revision: deployment.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.internalApplicationDeployments.id, deployment.id))
            .returning();
        }
        if (!deployment)
          throw new InternalApplicationInvariantError("Deployment write returned no row");
        const [operation] = await tx
          .insert(schema.internalApplicationDeploymentOperations)
          .values({
            id: input.operationId,
            accountId: app.accountId,
            workspaceId: input.workspaceId,
            deploymentId: deployment.id,
            kind: "plan",
            status: input.plan.destructive ? "awaiting_approval" : "planned",
            requestHash: input.requestHash,
            plan: input.plan,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        if (!operation)
          throw new InternalApplicationInvariantError("Plan operation insert returned no row");
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: app.accountId,
          workspaceId: input.workspaceId,
          applicationId: app.id,
          deploymentId: deployment.id,
          operationId: operation.id,
          type: "deployment.planned",
          actorSubjectId: input.actorSubjectId,
          facts: {
            planDigest: input.plan.digest,
            bundleId: input.plan.bundleId,
            bundleDigest: input.plan.bundleDigest,
            dataFlowDigest: hash(input.plan.dataFlows),
            runtimeIdentity: input.plan.runtimeIdentity,
            destructive: input.plan.destructive,
          },
        });
        return { deployment, operation };
      }),
  );
}

export async function getInternalApplicationDeploymentOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.internalApplicationDeploymentOperations)
      .where(
        and(
          eq(schema.internalApplicationDeploymentOperations.workspaceId, workspaceId),
          eq(schema.internalApplicationDeploymentOperations.id, operationId),
        ),
      )
      .limit(1);
    if (!row) throw new InternalApplicationNotFoundError("Deployment operation was not found");
    return projectInternalApplicationOperation(row);
  });
}

export async function listInternalApplicationDeploymentOperations(
  db: Database,
  workspaceId: string,
  deploymentId: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.internalApplicationDeploymentOperations)
        .where(
          and(
            eq(schema.internalApplicationDeploymentOperations.workspaceId, workspaceId),
            eq(schema.internalApplicationDeploymentOperations.deploymentId, deploymentId),
          ),
        )
        .orderBy(desc(schema.internalApplicationDeploymentOperations.createdAt))
        .limit(500)
    ).map(projectInternalApplicationOperation),
  );
}

export async function reconcileInternalApplicationUnknownOperation(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    observationOperationId: string;
    actorSubjectId: string;
  },
) {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [operation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentOperations.id, input.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!operation)
          throw new InternalApplicationNotFoundError("Deployment operation was not found");
        if (operation.status === "completed") return projectInternalApplicationOperation(operation);
        if (operation.status !== "outcome_unknown")
          throw new InternalApplicationInvariantError(
            "Only an outcome-unknown provider operation can be reconciled",
          );
        const [observation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.id, input.observationOperationId),
              eq(
                schema.internalApplicationDeploymentOperations.deploymentId,
                operation.deploymentId,
              ),
              eq(schema.internalApplicationDeploymentOperations.kind, "observe"),
              eq(schema.internalApplicationDeploymentOperations.status, "completed"),
            ),
          )
          .limit(1);
        if (!observation)
          throw new InternalApplicationInvariantError(
            "A successful observation is required to reconcile provider outcome",
          );
        const [deployment] = await tx
          .select()
          .from(schema.internalApplicationDeployments)
          .where(eq(schema.internalApplicationDeployments.id, operation.deploymentId))
          .limit(1);
        if (!deployment)
          throw new InternalApplicationInvariantError("Operation deployment disappeared");
        const now = new Date();
        const [updated] = await tx
          .update(schema.internalApplicationDeploymentOperations)
          .set({
            status: "completed",
            result: {
              ...(operation.result ?? {}),
              reconciled: true,
              reconciledByOperationId: observation.id,
              observedDeploymentStatus: deployment.status,
            },
            errorCode: null,
            errorMessage: null,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeploymentOperations.id, operation.id))
          .returning();
        if (!updated)
          throw new InternalApplicationInvariantError("Reconciliation update returned no row");
        const bundleId = operation.plan?.bundleId ?? deployment.activeBundleId;
        const bundleDigest =
          operation.plan?.bundleDigest ??
          (
            await tx
              .select({ digest: schema.internalApplicationBundles.digest })
              .from(schema.internalApplicationBundles)
              .where(eq(schema.internalApplicationBundles.id, bundleId!))
              .limit(1)
          )[0]?.digest ??
          null;
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: deployment.accountId,
          workspaceId: input.workspaceId,
          applicationId: deployment.applicationId,
          deploymentId: deployment.id,
          operationId: operation.id,
          type: `deployment.${operation.kind}_reconciled`,
          actorSubjectId: input.actorSubjectId,
          facts: {
            observationOperationId: observation.id,
            observedStatus: deployment.status,
            bundleId,
            bundleDigest,
          },
        });
        return projectInternalApplicationOperation(updated);
      }),
  );
}

export async function listInternalApplicationEvents(
  db: Database,
  workspaceId: string,
  applicationId: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.internalApplicationEvents)
        .where(
          and(
            eq(schema.internalApplicationEvents.workspaceId, workspaceId),
            eq(schema.internalApplicationEvents.applicationId, applicationId),
          ),
        )
        .orderBy(desc(schema.internalApplicationEvents.createdAt))
        .limit(500)
    ).map(projectInternalApplicationEvent),
  );
}

export async function recordInternalApplicationBuildSessionStarted(
  db: Database,
  input: {
    workspaceId: string;
    applicationId: string;
    operationId: string;
    expectedApplicationRevision: number;
    sessionId: string;
    targetId: string | null;
    actorSubjectId: string;
  },
) {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [app] = await tx
          .select()
          .from(schema.internalApplications)
          .where(
            and(
              eq(schema.internalApplications.workspaceId, input.workspaceId),
              eq(schema.internalApplications.id, input.applicationId),
            ),
          )
          .limit(1);
        if (!app?.headRevisionId)
          throw new InternalApplicationNotFoundError("Application was not found");
        if (app.headRevision !== input.expectedApplicationRevision)
          throw new InternalApplicationVersionConflictError(
            "Application revision changed before build evidence was recorded",
          );
        const facts = {
          sessionId: input.sessionId,
          applicationRevision: app.headRevision,
          applicationRevisionId: app.headRevisionId,
          definitionHash: app.definitionHash,
          targetId: input.targetId,
        };
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationEvents)
          .where(eq(schema.internalApplicationEvents.id, input.operationId))
          .limit(1);
        if (existing) {
          if (
            existing.type !== "application.build_session_started" ||
            existing.applicationId !== app.id ||
            stableJson(existing.facts) !== stableJson(facts)
          )
            throw new InternalApplicationIdempotencyError("Build operation id was reused");
          return projectInternalApplicationEvent(existing);
        }
        const [created] = await tx
          .insert(schema.internalApplicationEvents)
          .values({
            id: input.operationId,
            accountId: app.accountId,
            workspaceId: input.workspaceId,
            applicationId: app.id,
            type: "application.build_session_started",
            actorSubjectId: input.actorSubjectId,
            facts,
          })
          .returning();
        if (!created)
          throw new InternalApplicationInvariantError(
            "Build-session evidence insert returned no row",
          );
        return projectInternalApplicationEvent(created);
      }),
  );
}

export const internalApplicationRequestHash = hash;

export async function resolveInternalApplicationPlanInputs(
  db: Database,
  workspaceId: string,
  rawRequest: PlanInternalApplicationDeploymentRequest,
) {
  const request = PlanInternalApplicationDeploymentRequest.parse(rawRequest);
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const detail = await detailInScope(scoped, workspaceId, request.applicationId);
    if (detail.application.headRevision !== request.expectedApplicationRevision) {
      throw new InternalApplicationVersionConflictError("Application revision changed");
    }
    const [bundleRow] = await scoped
      .select()
      .from(schema.internalApplicationBundles)
      .where(
        and(
          eq(schema.internalApplicationBundles.workspaceId, workspaceId),
          eq(schema.internalApplicationBundles.applicationId, request.applicationId),
          eq(schema.internalApplicationBundles.id, request.bundleId),
        ),
      )
      .limit(1);
    if (!bundleRow || bundleRow.status !== "ready") {
      throw new InternalApplicationNotFoundError("Ready application bundle was not found");
    }
    if (bundleRow.applicationRevisionId !== detail.headRevision.id) {
      throw new InternalApplicationVersionConflictError(
        "Bundle does not match the application revision",
      );
    }
    const [targetRow] = await scoped
      .select()
      .from(schema.internalApplicationDeploymentTargets)
      .where(
        and(
          eq(schema.internalApplicationDeploymentTargets.workspaceId, workspaceId),
          eq(schema.internalApplicationDeploymentTargets.id, request.targetId),
        ),
      )
      .limit(1);
    if (!targetRow || targetRow.status === "disabled") {
      throw new InternalApplicationNotFoundError("Active deployment target was not found");
    }
    if (targetRow.revision !== request.expectedTargetRevision) {
      throw new InternalApplicationVersionConflictError("Deployment target revision changed");
    }
    if (targetRow.environment !== request.environment) {
      throw new InternalApplicationInvariantError("Deployment target environment does not match");
    }
    const sources = await Promise.all(
      detail.headRevision.definition.dataBindings.map(async (binding) => {
        const [row] = await scoped
          .select()
          .from(schema.internalApplicationDataSources)
          .where(
            and(
              eq(schema.internalApplicationDataSources.workspaceId, workspaceId),
              eq(schema.internalApplicationDataSources.id, binding.dataSourceId),
            ),
          )
          .limit(1);
        if (!row || row.status !== "active") {
          throw new InternalApplicationNotFoundError(
            `Data source ${binding.mountName} was not found`,
          );
        }
        if (row.revision !== binding.expectedRevision) {
          throw new InternalApplicationVersionConflictError(
            `Data source ${binding.mountName} revision changed`,
          );
        }
        if (!row.allowedAccessModes.includes(binding.accessMode)) {
          throw new InternalApplicationInvariantError(
            `Data source ${binding.mountName} does not allow ${binding.accessMode}`,
          );
        }
        return dataSource(row);
      }),
    );
    const [currentDeploymentRow] = await scoped
      .select()
      .from(schema.internalApplicationDeployments)
      .where(
        and(
          eq(schema.internalApplicationDeployments.applicationId, request.applicationId),
          eq(schema.internalApplicationDeployments.environment, request.environment),
        ),
      )
      .limit(1);
    return {
      request,
      application: detail,
      bundle: bundle(bundleRow),
      target: target(targetRow),
      dataSources: sources,
      currentDeployment: currentDeploymentRow
        ? projectInternalApplicationDeployment(currentDeploymentRow)
        : null,
    };
  });
}

export async function approveInternalApplicationDeploymentPlan(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    actorSubjectId: string;
    request: ApproveInternalApplicationDeploymentRequest;
  },
) {
  const request = ApproveInternalApplicationDeploymentRequest.parse(input.request);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [operation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentOperations.id, input.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!operation?.plan)
          throw new InternalApplicationNotFoundError("Deployment plan was not found");
        if (operation.plan.digest !== request.expectedPlanDigest) {
          throw new InternalApplicationVersionConflictError("Deployment plan digest changed");
        }
        if (operation.plan.policyChecks.some((check) => check.status === "fail")) {
          throw new InternalApplicationInvariantError("A failing policy check cannot be approved");
        }
        const now = new Date();
        const [updated] = await tx
          .update(schema.internalApplicationDeploymentOperations)
          .set({
            status: "approved",
            approvedBySubjectId: operation.approvedBySubjectId ?? input.actorSubjectId,
            approvedAt: operation.approvedAt ?? now,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeploymentOperations.id, operation.id))
          .returning();
        if (!updated)
          throw new InternalApplicationInvariantError("Approval update returned no row");
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: operation.accountId,
          workspaceId: input.workspaceId,
          applicationId: operation.plan.applicationId,
          deploymentId: operation.deploymentId,
          operationId: operation.id,
          type: "deployment.approved",
          actorSubjectId: input.actorSubjectId,
          facts: {
            planDigest: operation.plan.digest,
            bundleId: operation.plan.bundleId,
            bundleDigest: operation.plan.bundleDigest,
            dataFlowDigest: hash(operation.plan.dataFlows),
            runtimeIdentity: operation.plan.runtimeIdentity,
          },
        });
        return projectInternalApplicationOperation(updated);
      }),
  );
}

export async function beginInternalApplicationApply(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    planOperationId: string;
    expectedPlanDigest: string;
    actorSubjectId: string;
  },
) {
  const requestHash = hash({
    operationId: input.operationId,
    planOperationId: input.planOperationId,
    expectedPlanDigest: input.expectedPlanDigest,
  });
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(eq(schema.internalApplicationDeploymentOperations.id, input.operationId))
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new InternalApplicationIdempotencyError("Apply operation id was reused");
          const [deployment] = await tx
            .select()
            .from(schema.internalApplicationDeployments)
            .where(eq(schema.internalApplicationDeployments.id, existing.deploymentId))
            .limit(1);
          if (!deployment || !existing.plan)
            throw new InternalApplicationInvariantError("Apply operation is incomplete");
          return {
            deployment,
            operation: existing,
            plan: existing.plan,
            replay: true,
          };
        }
        const [planOperation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentOperations.id, input.planOperationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!planOperation?.plan)
          throw new InternalApplicationNotFoundError("Deployment plan was not found");
        if (planOperation.plan.digest !== input.expectedPlanDigest)
          throw new InternalApplicationVersionConflictError("Deployment plan digest changed");
        if (planOperation.plan.policyChecks.some((check) => check.status === "fail"))
          throw new InternalApplicationInvariantError(
            "A plan with failing policy checks cannot be applied",
          );
        if (planOperation.plan.destructive && planOperation.status !== "approved")
          throw new InternalApplicationInvariantError("Destructive plan requires approval");
        const [deployment] = await tx
          .select()
          .from(schema.internalApplicationDeployments)
          .where(eq(schema.internalApplicationDeployments.id, planOperation.deploymentId))
          .for("update")
          .limit(1);
        if (!deployment || deployment.desiredBundleId !== planOperation.plan.bundleId)
          throw new InternalApplicationVersionConflictError("Deployment desired state changed");
        const now = new Date();
        const [updatedDeployment] = await tx
          .update(schema.internalApplicationDeployments)
          .set({
            status: "deploying",
            revision: deployment.revision + 1,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeployments.id, deployment.id))
          .returning();
        const [operation] = await tx
          .insert(schema.internalApplicationDeploymentOperations)
          .values({
            id: input.operationId,
            accountId: deployment.accountId,
            workspaceId: input.workspaceId,
            deploymentId: deployment.id,
            kind: "apply",
            status: "provider_started",
            requestHash,
            plan: planOperation.plan,
            approvedBySubjectId: planOperation.approvedBySubjectId,
            approvedAt: planOperation.approvedAt,
            providerStarted: true,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        if (!updatedDeployment || !operation)
          throw new InternalApplicationInvariantError("Apply admission returned no row");
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: deployment.accountId,
          workspaceId: input.workspaceId,
          applicationId: deployment.applicationId,
          deploymentId: deployment.id,
          operationId: operation.id,
          type: "deployment.apply_started",
          actorSubjectId: input.actorSubjectId,
          facts: {
            planDigest: planOperation.plan.digest,
            bundleId: planOperation.plan.bundleId,
            bundleDigest: planOperation.plan.bundleDigest,
            dataFlowDigest: hash(planOperation.plan.dataFlows),
            runtimeIdentity: planOperation.plan.runtimeIdentity,
          },
        });
        return {
          deployment: updatedDeployment,
          operation,
          plan: planOperation.plan,
          replay: false,
        };
      }),
  );
}

export async function settleInternalApplicationApply(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    outcome: "succeeded" | "failed" | "unknown";
    actorSubjectId: string;
    internalUrl?: string | null;
    result?: Record<string, string | number | boolean>;
    errorCode?: string;
    errorMessage?: string;
  },
) {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [operation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentOperations.id, input.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!operation?.plan)
          throw new InternalApplicationNotFoundError("Apply operation was not found");
        const [deployment] = await tx
          .select()
          .from(schema.internalApplicationDeployments)
          .where(eq(schema.internalApplicationDeployments.id, operation.deploymentId))
          .for("update")
          .limit(1);
        if (!deployment)
          throw new InternalApplicationInvariantError("Apply deployment was not found");
        if (["completed", "failed", "outcome_unknown"].includes(operation.status))
          return { deployment, operation };
        const now = new Date();
        const succeeded = input.outcome === "succeeded";
        const [updatedDeployment] = await tx
          .update(schema.internalApplicationDeployments)
          .set({
            status: succeeded ? "running" : input.outcome === "unknown" ? "degraded" : "failed",
            ...(succeeded
              ? {
                  previousBundleId: deployment.activeBundleId,
                  activeBundleId: operation.plan.bundleId,
                  desiredBundleId: operation.plan.bundleId,
                  internalUrl: input.internalUrl ?? deployment.internalUrl,
                }
              : {}),
            revision: deployment.revision + 1,
            lastObservedAt: succeeded ? now : deployment.lastObservedAt,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeployments.id, deployment.id))
          .returning();
        const [updatedOperation] = await tx
          .update(schema.internalApplicationDeploymentOperations)
          .set({
            status: succeeded
              ? "completed"
              : input.outcome === "unknown"
                ? "outcome_unknown"
                : "failed",
            result: input.result ?? null,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeploymentOperations.id, operation.id))
          .returning();
        if (!updatedDeployment || !updatedOperation)
          throw new InternalApplicationInvariantError("Apply settlement returned no row");
        if (succeeded) {
          await tx
            .update(schema.internalApplications)
            .set({ status: "active", updatedAt: now })
            .where(
              and(
                eq(schema.internalApplications.id, deployment.applicationId),
                eq(schema.internalApplications.status, "draft"),
              ),
            );
        }
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: deployment.accountId,
          workspaceId: input.workspaceId,
          applicationId: deployment.applicationId,
          deploymentId: deployment.id,
          operationId: operation.id,
          type: `deployment.apply_${input.outcome}`,
          actorSubjectId: input.actorSubjectId,
          facts: {
            planDigest: operation.plan.digest,
            bundleId: operation.plan.bundleId,
            bundleDigest: operation.plan.bundleDigest,
            dataFlowDigest: hash(operation.plan.dataFlows),
            runtimeIdentity: operation.plan.runtimeIdentity,
          },
        });
        return { deployment: updatedDeployment, operation: updatedOperation };
      }),
  );
}

export async function resolveInternalApplicationDeploymentRuntime(
  db: Database,
  workspaceId: string,
  deploymentId: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [deployment] = await scoped
      .select()
      .from(schema.internalApplicationDeployments)
      .where(
        and(
          eq(schema.internalApplicationDeployments.workspaceId, workspaceId),
          eq(schema.internalApplicationDeployments.id, deploymentId),
        ),
      )
      .limit(1);
    if (!deployment) throw new InternalApplicationNotFoundError("Deployment was not found");
    const [targetRow] = await scoped
      .select()
      .from(schema.internalApplicationDeploymentTargets)
      .where(eq(schema.internalApplicationDeploymentTargets.id, deployment.targetId))
      .limit(1);
    if (!targetRow) throw new InternalApplicationInvariantError("Deployment target was not found");
    const bundleId = deployment.activeBundleId ?? deployment.desiredBundleId;
    const [bundleRow] = bundleId
      ? await scoped
          .select()
          .from(schema.internalApplicationBundles)
          .where(eq(schema.internalApplicationBundles.id, bundleId))
          .limit(1)
      : [];
    return {
      deployment: projectInternalApplicationDeployment(deployment),
      target: target(targetRow),
      bundle: bundleRow ? bundle(bundleRow) : null,
      previousBundleId: deployment.previousBundleId,
    };
  });
}

export async function resolveInternalApplicationProviderInputs(
  db: Database,
  input: {
    workspaceId: string;
    applicationId: string;
    bundleId: string;
    targetId: string;
    allowInactive?: boolean;
  },
) {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [app] = await scoped
      .select()
      .from(schema.internalApplications)
      .where(
        and(
          eq(schema.internalApplications.workspaceId, input.workspaceId),
          eq(schema.internalApplications.id, input.applicationId),
        ),
      )
      .limit(1);
    if (!app) throw new InternalApplicationNotFoundError("Application was not found");
    const [bundleRow] = await scoped
      .select()
      .from(schema.internalApplicationBundles)
      .where(
        and(
          eq(schema.internalApplicationBundles.workspaceId, input.workspaceId),
          eq(schema.internalApplicationBundles.applicationId, input.applicationId),
          eq(schema.internalApplicationBundles.id, input.bundleId),
        ),
      )
      .limit(1);
    if (!bundleRow || (!input.allowInactive && bundleRow.status !== "ready"))
      throw new InternalApplicationNotFoundError("Ready application bundle was not found");
    const [revisionRow] = await scoped
      .select()
      .from(schema.internalApplicationRevisions)
      .where(
        and(
          eq(schema.internalApplicationRevisions.applicationId, input.applicationId),
          eq(schema.internalApplicationRevisions.id, bundleRow.applicationRevisionId),
        ),
      )
      .limit(1);
    if (!revisionRow) throw new InternalApplicationInvariantError("Bundle revision was not found");
    const [targetRow] = await scoped
      .select()
      .from(schema.internalApplicationDeploymentTargets)
      .where(
        and(
          eq(schema.internalApplicationDeploymentTargets.workspaceId, input.workspaceId),
          eq(schema.internalApplicationDeploymentTargets.id, input.targetId),
        ),
      )
      .limit(1);
    if (!targetRow || (!input.allowInactive && targetRow.status === "disabled"))
      throw new InternalApplicationNotFoundError("Active deployment target was not found");
    const dataSources = await Promise.all(
      revisionRow.definition.dataBindings.map(async (binding) => {
        const [row] = await scoped
          .select()
          .from(schema.internalApplicationDataSources)
          .where(
            and(
              eq(schema.internalApplicationDataSources.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDataSources.id, binding.dataSourceId),
            ),
          )
          .limit(1);
        if (
          !row ||
          (!input.allowInactive && row.status !== "active") ||
          row.revision !== binding.expectedRevision
        )
          throw new InternalApplicationVersionConflictError(
            `Data source ${binding.mountName} changed`,
          );
        return dataSource(row);
      }),
    );
    return {
      application: InternalApplicationDetail.parse({
        application: applicationSummary(app),
        headRevision: revision(revisionRow),
      }),
      bundle: bundle(bundleRow),
      target: target(targetRow),
      dataSources,
    };
  });
}

export async function beginInternalApplicationSimpleOperation(
  db: Database,
  input: {
    workspaceId: string;
    deploymentId: string;
    operationId: string;
    kind: "observe" | "rollback" | "retire";
    actorSubjectId: string;
    expectedDeploymentRevision?: number;
  },
) {
  const requestHash = hash(input);
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [existing] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(eq(schema.internalApplicationDeploymentOperations.id, input.operationId))
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new InternalApplicationIdempotencyError("Operation id was reused");
          const [deployment] = await tx
            .select()
            .from(schema.internalApplicationDeployments)
            .where(eq(schema.internalApplicationDeployments.id, existing.deploymentId))
            .limit(1);
          if (!deployment)
            throw new InternalApplicationInvariantError("Operation deployment disappeared");
          return { deployment, operation: existing, replay: true };
        }
        const [deployment] = await tx
          .select()
          .from(schema.internalApplicationDeployments)
          .where(
            and(
              eq(schema.internalApplicationDeployments.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeployments.id, input.deploymentId),
            ),
          )
          .for("update")
          .limit(1);
        if (!deployment) throw new InternalApplicationNotFoundError("Deployment was not found");
        if (
          input.expectedDeploymentRevision !== undefined &&
          deployment.revision !== input.expectedDeploymentRevision
        )
          throw new InternalApplicationVersionConflictError("Deployment revision changed");
        if (input.kind === "rollback" && !deployment.previousBundleId)
          throw new InternalApplicationInvariantError(
            "Deployment has no previous bundle to roll back to",
          );
        const now = new Date();
        const [updatedDeployment] = await tx
          .update(schema.internalApplicationDeployments)
          .set({
            status: input.kind === "rollback" ? "rolling_back" : deployment.status,
            revision: deployment.revision + 1,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeployments.id, deployment.id))
          .returning();
        const [operation] = await tx
          .insert(schema.internalApplicationDeploymentOperations)
          .values({
            id: input.operationId,
            accountId: deployment.accountId,
            workspaceId: input.workspaceId,
            deploymentId: deployment.id,
            kind: input.kind,
            status: input.kind === "observe" ? "observing" : "provider_started",
            requestHash,
            providerStarted: true,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        if (!updatedDeployment || !operation)
          throw new InternalApplicationInvariantError("Operation admission returned no row");
        const evidenceBundleId =
          input.kind === "rollback" ? deployment.previousBundleId : deployment.activeBundleId;
        const [evidenceBundle] = evidenceBundleId
          ? await tx
              .select({ digest: schema.internalApplicationBundles.digest })
              .from(schema.internalApplicationBundles)
              .where(eq(schema.internalApplicationBundles.id, evidenceBundleId))
              .limit(1)
          : [];
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: deployment.accountId,
          workspaceId: input.workspaceId,
          applicationId: deployment.applicationId,
          deploymentId: deployment.id,
          operationId: operation.id,
          type: `deployment.${input.kind}_started`,
          actorSubjectId: input.actorSubjectId,
          facts: {
            bundleId: evidenceBundleId,
            bundleDigest: evidenceBundle?.digest ?? null,
            deploymentRevision: updatedDeployment.revision,
          },
        });
        return { deployment: updatedDeployment, operation, replay: false };
      }),
  );
}

export async function settleInternalApplicationSimpleOperation(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    actorSubjectId: string;
    outcome: "succeeded" | "failed" | "unknown";
    observedStatus?: "running" | "degraded" | "failed" | "retired";
    internalUrl?: string | null;
    result?: Record<string, string | number | boolean>;
    errorCode?: string;
    errorMessage?: string;
  },
) {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [operation] = await tx
          .select()
          .from(schema.internalApplicationDeploymentOperations)
          .where(
            and(
              eq(schema.internalApplicationDeploymentOperations.workspaceId, input.workspaceId),
              eq(schema.internalApplicationDeploymentOperations.id, input.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!operation)
          throw new InternalApplicationNotFoundError("Deployment operation was not found");
        const [deployment] = await tx
          .select()
          .from(schema.internalApplicationDeployments)
          .where(eq(schema.internalApplicationDeployments.id, operation.deploymentId))
          .for("update")
          .limit(1);
        if (!deployment)
          throw new InternalApplicationInvariantError("Operation deployment was not found");
        if (["completed", "failed", "outcome_unknown"].includes(operation.status))
          return { deployment, operation };
        const now = new Date();
        const succeeded = input.outcome === "succeeded";
        const rollback = operation.kind === "rollback";
        const retire = operation.kind === "retire";
        const evidenceBundleId = rollback ? deployment.previousBundleId : deployment.activeBundleId;
        const [evidenceBundle] = evidenceBundleId
          ? await tx
              .select({ digest: schema.internalApplicationBundles.digest })
              .from(schema.internalApplicationBundles)
              .where(eq(schema.internalApplicationBundles.id, evidenceBundleId))
              .limit(1)
          : [];
        const nextStatus = succeeded
          ? retire
            ? "retired"
            : rollback
              ? "rolled_back"
              : (input.observedStatus ?? deployment.status)
          : input.outcome === "unknown"
            ? "degraded"
            : "failed";
        const [updatedDeployment] = await tx
          .update(schema.internalApplicationDeployments)
          .set({
            status: nextStatus,
            ...(succeeded && rollback
              ? {
                  activeBundleId: deployment.previousBundleId,
                  previousBundleId: deployment.activeBundleId,
                  desiredBundleId: deployment.previousBundleId,
                }
              : {}),
            ...(retire && succeeded
              ? { internalUrl: null, desiredBundleId: null }
              : input.internalUrl !== undefined
                ? { internalUrl: input.internalUrl }
                : {}),
            revision: deployment.revision + 1,
            lastObservedAt:
              operation.kind === "observe" && succeeded ? now : deployment.lastObservedAt,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeployments.id, deployment.id))
          .returning();
        const [updatedOperation] = await tx
          .update(schema.internalApplicationDeploymentOperations)
          .set({
            status: succeeded
              ? "completed"
              : input.outcome === "unknown"
                ? "outcome_unknown"
                : "failed",
            result: input.result ?? null,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
            updatedAt: now,
          })
          .where(eq(schema.internalApplicationDeploymentOperations.id, operation.id))
          .returning();
        if (!updatedDeployment || !updatedOperation)
          throw new InternalApplicationInvariantError("Operation settlement returned no row");
        await tx.insert(schema.internalApplicationEvents).values({
          accountId: deployment.accountId,
          workspaceId: input.workspaceId,
          applicationId: deployment.applicationId,
          deploymentId: deployment.id,
          operationId: operation.id,
          type: `deployment.${operation.kind}_${input.outcome}`,
          actorSubjectId: input.actorSubjectId,
          facts: {
            status: nextStatus,
            bundleId: evidenceBundleId,
            bundleDigest: evidenceBundle?.digest ?? null,
            deploymentRevision: updatedDeployment.revision,
          },
        });
        return { deployment: updatedDeployment, operation: updatedOperation };
      }),
  );
}
