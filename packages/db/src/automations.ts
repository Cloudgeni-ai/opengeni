import {
  AutomationAcceptedExecution,
  AutomationNormalizedEvent,
  AutomationSessionTemplate,
  CapabilityPack,
  stableJson,
  type AutomationRun,
  type AutomationSource,
  type AutomationTrigger,
  type CreateAutomationSourceRequest,
  type CreateAutomationTriggerRequest,
  type UpdateAutomationSourceRequest,
  type UpdateAutomationTriggerRequest,
} from "@opengeni/contracts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withWorkspaceRls } from "./database";
import * as schema from "./schema";

type SourceRow = typeof schema.automationSources.$inferSelect;
type TriggerRow = typeof schema.automationTriggers.$inferSelect;
type RevisionRow = typeof schema.automationTriggerRevisions.$inferSelect;
type EventRow = typeof schema.automationTriggerEvents.$inferSelect;
type RunRow = typeof schema.automationRuns.$inferSelect;

export class AutomationDeliveryConflictError extends Error {
  readonly name = "AutomationDeliveryConflictError";
  constructor() {
    super("Automation delivery identity was reused with different authenticated bytes");
  }
}

export class AutomationRevisionConflictError extends Error {
  readonly name = "AutomationRevisionConflictError";
  constructor() {
    super("Automation trigger changed since it was read");
  }
}

export class AutomationAuthorityRevokedError extends Error {
  readonly name = "AutomationAuthorityRevokedError";
  constructor(message = "Automation dispatch authority is no longer active") {
    super(message);
  }
}

export type AutomationSourceSecret = AutomationSource & {
  webhookSecretEncrypted: string;
};

export type AutomationTriggerWithRevision = AutomationTrigger & {
  sourceStatus: "active" | "disabled";
  sourceVersion: number;
  sourceConfiguration: Record<string, unknown>;
};

export type AutomationStoredEvent = {
  id: string;
  accountId: string;
  workspaceId: string;
  sourceId: string;
  sourceVersion: number;
  sourceConfiguration: Record<string, unknown>;
  matchedTriggerRevisions: Array<{ triggerId: string; revision: number }>;
  deliveryKey: string;
  requestDigest: string;
  normalizedEvent: AutomationNormalizedEvent;
  status: "accepted" | "ignored" | "failed";
  ignoredReason: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRunExecution = AutomationRun & {
  acceptedExecution: AutomationAcceptedExecution;
};

export async function createAutomationSource(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    createdBySubjectId: string;
    request: CreateAutomationSourceRequest;
    webhookSecretEncrypted: string;
    packInstallationId?: string | null;
    packConnectorId?: string | null;
  },
): Promise<AutomationSource> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.automationSources)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            name: input.request.name,
            adapterId: input.request.adapterId,
            configuration: input.request.configuration,
            webhookSecretEncrypted: input.webhookSecretEncrypted,
            packInstallationId: input.packInstallationId ?? null,
            packConnectorId: input.packConnectorId ?? null,
            createdBySubjectId: input.createdBySubjectId,
          })
          .returning();
        if (!row) throw new Error("Failed to create automation source");
        await tx.insert(schema.automationWebhookEndpoints).values({
          endpointId: row.endpointId,
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          sourceId: row.id,
        });
        return mapSource(row);
      }),
  );
}

export async function resolveAutomationWebhookEndpoint(
  db: Database,
  endpointId: string,
): Promise<{
  accountId: string;
  workspaceId: string;
  sourceId: string;
} | null> {
  const [row] = await db
    .select({
      accountId: schema.automationWebhookEndpoints.accountId,
      workspaceId: schema.automationWebhookEndpoints.workspaceId,
      sourceId: schema.automationWebhookEndpoints.sourceId,
    })
    .from(schema.automationWebhookEndpoints)
    .where(eq(schema.automationWebhookEndpoints.endpointId, endpointId))
    .limit(1);
  return row ?? null;
}

export async function getAutomationSourceSecret(
  db: Database,
  input: { accountId: string; workspaceId: string; sourceId: string },
): Promise<AutomationSourceSecret | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.automationSources)
      .where(
        and(
          eq(schema.automationSources.accountId, input.accountId),
          eq(schema.automationSources.workspaceId, input.workspaceId),
          eq(schema.automationSources.id, input.sourceId),
        ),
      )
      .limit(1);
    return row
      ? {
          ...mapSource(row),
          webhookSecretEncrypted: row.webhookSecretEncrypted,
        }
      : null;
  });
}

export async function listAutomationSources(
  db: Database,
  workspaceId: string,
): Promise<AutomationSource[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.automationSources)
        .where(eq(schema.automationSources.workspaceId, workspaceId))
        .orderBy(desc(schema.automationSources.updatedAt))
    ).map(mapSource),
  );
}

export async function updateAutomationSource(
  db: Database,
  input: {
    workspaceId: string;
    sourceId: string;
    request: UpdateAutomationSourceRequest;
    webhookSecretEncrypted?: string;
  },
): Promise<AutomationSource | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [row] = await scoped
      .update(schema.automationSources)
      .set({
        ...(input.request.name !== undefined ? { name: input.request.name } : {}),
        ...(input.request.configuration !== undefined
          ? { configuration: input.request.configuration }
          : {}),
        ...(input.request.status !== undefined ? { status: input.request.status } : {}),
        ...(input.webhookSecretEncrypted !== undefined
          ? { webhookSecretEncrypted: input.webhookSecretEncrypted }
          : {}),
        version: sql`${schema.automationSources.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.automationSources.workspaceId, input.workspaceId),
          eq(schema.automationSources.id, input.sourceId),
          isNull(schema.automationSources.packInstallationId),
        ),
      )
      .returning();
    return row ? mapSource(row) : null;
  });
}

export async function createAutomationTrigger(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    createdBySubjectId: string;
    request: CreateAutomationTriggerRequest;
    adapterId: string;
  },
): Promise<AutomationTrigger> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        const [source] = await tx
          .select({
            id: schema.automationSources.id,
            adapterId: schema.automationSources.adapterId,
            status: schema.automationSources.status,
            packInstallationId: schema.automationSources.packInstallationId,
          })
          .from(schema.automationSources)
          .where(
            and(
              eq(schema.automationSources.accountId, input.accountId),
              eq(schema.automationSources.workspaceId, input.workspaceId),
              eq(schema.automationSources.id, input.request.sourceId),
            ),
          )
          .limit(1);
        if (!source) throw new Error("Automation source not found");
        if (source.status !== "active") throw new Error("Automation source is disabled");
        if (source.adapterId !== input.adapterId) {
          throw new Error("Automation source and trigger adapter do not match");
        }
        if (source.packInstallationId !== input.request.packInstallationId) {
          throw new Error("Automation source and trigger Pack ownership do not match");
        }
        if (input.request.packInstallationId) {
          const [installation] = await tx
            .select({
              status: schema.packInstallations.status,
              manifestSnapshot: schema.packInstallations.manifestSnapshot,
            })
            .from(schema.packInstallations)
            .where(
              and(
                eq(schema.packInstallations.workspaceId, input.workspaceId),
                eq(schema.packInstallations.id, input.request.packInstallationId),
              ),
            )
            .limit(1);
          const manifest = installation?.manifestSnapshot
            ? CapabilityPack.safeParse(installation.manifestSnapshot)
            : null;
          if (!installation || installation.status !== "active" || !manifest?.success) {
            throw new Error("Automation Pack installation is not active");
          }
          const template = manifest.data.automationTemplates?.find(
            (candidate) => candidate.id === input.request.packTemplateId,
          );
          if (!template || template.adapterId !== input.adapterId) {
            throw new Error("Automation Pack template does not match the source adapter");
          }
          if (
            stableJson([...new Set(input.request.eventTypes)].sort()) !==
              stableJson([...new Set(template.eventTypes)].sort()) ||
            stableJson(input.request.configuration) !== stableJson(template.configuration) ||
            stableJson(input.request.sessionTemplate) !== stableJson(template.sessionTemplate)
          ) {
            throw new Error("Automation Pack trigger must use its frozen manifest template");
          }
        }
        const [head] = await tx
          .insert(schema.automationTriggers)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.request.sourceId,
            name: input.request.name,
            status: input.request.status,
            packInstallationId: input.request.packInstallationId,
            packTemplateId: input.request.packTemplateId,
            createdBySubjectId: input.createdBySubjectId,
          })
          .returning();
        if (!head) throw new Error("Failed to create automation trigger");
        const [revision] = await tx
          .insert(schema.automationTriggerRevisions)
          .values({
            triggerId: head.id,
            revision: 1,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            adapterId: input.adapterId,
            eventTypes: [...new Set(input.request.eventTypes)],
            configuration: input.request.configuration,
            parameters: input.request.parameters,
            sessionTemplate: input.request.sessionTemplate,
            createdBySubjectId: input.createdBySubjectId,
          })
          .returning();
        if (!revision) throw new Error("Failed to create automation trigger revision");
        return mapTrigger(head, revision);
      }),
  );
}

export async function listAutomationTriggers(
  db: Database,
  workspaceId: string,
): Promise<AutomationTrigger[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select({
        head: schema.automationTriggers,
        revision: schema.automationTriggerRevisions,
      })
      .from(schema.automationTriggers)
      .innerJoin(
        schema.automationTriggerRevisions,
        and(
          eq(schema.automationTriggerRevisions.triggerId, schema.automationTriggers.id),
          eq(schema.automationTriggerRevisions.revision, schema.automationTriggers.currentRevision),
        ),
      )
      .where(eq(schema.automationTriggers.workspaceId, workspaceId))
      .orderBy(desc(schema.automationTriggers.updatedAt));
    return rows.map(({ head, revision }) => mapTrigger(head, revision));
  });
}

export async function listActiveAutomationTriggersForSource(
  db: Database,
  input: { accountId: string; workspaceId: string; sourceId: string },
): Promise<AutomationTriggerWithRevision[]> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const rows = await scoped
      .select({
        head: schema.automationTriggers,
        revision: schema.automationTriggerRevisions,
        sourceStatus: schema.automationSources.status,
        sourceVersion: schema.automationSources.version,
        sourceConfiguration: schema.automationSources.configuration,
      })
      .from(schema.automationTriggers)
      .innerJoin(
        schema.automationTriggerRevisions,
        and(
          eq(schema.automationTriggerRevisions.triggerId, schema.automationTriggers.id),
          eq(schema.automationTriggerRevisions.revision, schema.automationTriggers.currentRevision),
        ),
      )
      .innerJoin(
        schema.automationSources,
        eq(schema.automationSources.id, schema.automationTriggers.sourceId),
      )
      .where(
        and(
          eq(schema.automationTriggers.accountId, input.accountId),
          eq(schema.automationTriggers.workspaceId, input.workspaceId),
          eq(schema.automationTriggers.sourceId, input.sourceId),
          eq(schema.automationTriggers.status, "active"),
          eq(schema.automationSources.status, "active"),
        ),
      );
    return rows.map((row) => ({
      ...mapTrigger(row.head, row.revision),
      sourceStatus: row.sourceStatus as "active" | "disabled",
      sourceVersion: row.sourceVersion,
      sourceConfiguration: row.sourceConfiguration,
    }));
  });
}

export async function getAutomationTriggerRevisions(
  db: Database,
  input: {
    workspaceId: string;
    refs: Array<{ triggerId: string; revision: number }>;
  },
): Promise<AutomationTrigger[]> {
  if (input.refs.length === 0) return [];
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const rows = await scoped
      .select({
        head: schema.automationTriggers,
        revision: schema.automationTriggerRevisions,
      })
      .from(schema.automationTriggers)
      .innerJoin(
        schema.automationTriggerRevisions,
        eq(schema.automationTriggerRevisions.triggerId, schema.automationTriggers.id),
      )
      .where(
        and(
          eq(schema.automationTriggers.workspaceId, input.workspaceId),
          inArray(
            schema.automationTriggers.id,
            input.refs.map((ref) => ref.triggerId),
          ),
        ),
      );
    const byIdentity = new Map(
      rows.map(({ head, revision }) => [
        `${head.id}:${revision.revision}`,
        mapTrigger(head, revision, revision.revision),
      ]),
    );
    return input.refs
      .map((ref) => byIdentity.get(`${ref.triggerId}:${ref.revision}`))
      .filter((trigger): trigger is AutomationTrigger => Boolean(trigger));
  });
}

export async function updateAutomationTrigger(
  db: Database,
  input: {
    workspaceId: string;
    triggerId: string;
    subjectId: string;
    request: UpdateAutomationTriggerRequest;
  },
): Promise<AutomationTrigger | null> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            head: schema.automationTriggers,
            revision: schema.automationTriggerRevisions,
          })
          .from(schema.automationTriggers)
          .innerJoin(
            schema.automationTriggerRevisions,
            and(
              eq(schema.automationTriggerRevisions.triggerId, schema.automationTriggers.id),
              eq(
                schema.automationTriggerRevisions.revision,
                schema.automationTriggers.currentRevision,
              ),
            ),
          )
          .where(
            and(
              eq(schema.automationTriggers.workspaceId, input.workspaceId),
              eq(schema.automationTriggers.id, input.triggerId),
            ),
          )
          .for("update")
          .limit(1);
        if (!existing) return null;
        if (existing.head.currentRevision !== input.request.expectedRevision) {
          throw new AutomationRevisionConflictError();
        }
        if (existing.head.packInstallationId) {
          throw new Error(
            "Pack-owned automation triggers must be managed through their Pack setup API",
          );
        }
        const revisionNumber = existing.head.currentRevision + 1;
        const [head] = await tx
          .update(schema.automationTriggers)
          .set({
            ...(input.request.name !== undefined ? { name: input.request.name } : {}),
            ...(input.request.status !== undefined ? { status: input.request.status } : {}),
            currentRevision: revisionNumber,
            updatedAt: new Date(),
          })
          .where(eq(schema.automationTriggers.id, input.triggerId))
          .returning();
        if (!head) throw new Error("Failed to update automation trigger");
        const [revision] = await tx
          .insert(schema.automationTriggerRevisions)
          .values({
            triggerId: head.id,
            revision: revisionNumber,
            accountId: head.accountId,
            workspaceId: head.workspaceId,
            adapterId: existing.revision.adapterId,
            eventTypes: input.request.eventTypes
              ? [...new Set(input.request.eventTypes)]
              : existing.revision.eventTypes,
            configuration: input.request.configuration ?? existing.revision.configuration,
            parameters: input.request.parameters ?? existing.revision.parameters,
            sessionTemplate: input.request.sessionTemplate ?? existing.revision.sessionTemplate,
            createdBySubjectId: input.subjectId,
          })
          .returning();
        if (!revision) throw new Error("Failed to write automation trigger revision");
        return mapTrigger(head, revision);
      }),
  );
}

export async function recordAutomationEvent(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    sourceVersion: number;
    sourceConfiguration: Record<string, unknown>;
    matchedTriggerRevisions: Array<{ triggerId: string; revision: number }>;
    deliveryKey: string;
    requestDigest: string;
    normalizedEvent: AutomationNormalizedEvent;
    ignoredReason?: string | null;
  },
): Promise<{ event: AutomationStoredEvent; duplicate: boolean }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [inserted] = await scoped
      .insert(schema.automationTriggerEvents)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        sourceConfiguration: input.sourceConfiguration,
        matchedTriggerRevisions: input.matchedTriggerRevisions,
        deliveryKey: input.deliveryKey,
        requestDigest: input.requestDigest,
        adapterId: input.normalizedEvent.adapterId,
        eventType: input.normalizedEvent.eventType,
        occurrenceKey: input.normalizedEvent.occurrenceKey,
        normalizedEvent: input.normalizedEvent,
        status: input.ignoredReason ? "ignored" : "accepted",
        ignoredReason: input.ignoredReason ?? null,
      })
      .onConflictDoNothing({
        target: [
          schema.automationTriggerEvents.sourceId,
          schema.automationTriggerEvents.deliveryKey,
        ],
      })
      .returning();
    if (inserted) return { event: mapEvent(inserted), duplicate: false };
    const [existing] = await scoped
      .select()
      .from(schema.automationTriggerEvents)
      .where(
        and(
          eq(schema.automationTriggerEvents.sourceId, input.sourceId),
          eq(schema.automationTriggerEvents.deliveryKey, input.deliveryKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Automation delivery conflict could not be resolved");
    if (existing.requestDigest !== input.requestDigest) {
      throw new AutomationDeliveryConflictError();
    }
    return { event: mapEvent(existing), duplicate: true };
  });
}

export async function createAutomationRun(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    triggerId: string;
    triggerRevision: number;
    eventId: string;
    occurrenceKey: string;
    acceptedExecution: AutomationAcceptedExecution;
  },
): Promise<{ run: AutomationRunExecution; duplicate: boolean }> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.automationRuns)
          .values(input)
          .onConflictDoNothing({
            target: [schema.automationRuns.triggerId, schema.automationRuns.occurrenceKey],
          })
          .returning();
        const row =
          inserted ??
          (
            await tx
              .select()
              .from(schema.automationRuns)
              .where(
                and(
                  eq(schema.automationRuns.triggerId, input.triggerId),
                  eq(schema.automationRuns.occurrenceKey, input.occurrenceKey),
                ),
              )
              .limit(1)
          )[0];
        if (!row) throw new Error("Automation run conflict could not be resolved");
        if (
          row.accountId !== input.accountId ||
          row.workspaceId !== input.workspaceId ||
          row.sourceId !== input.sourceId ||
          row.triggerId !== input.triggerId
        ) {
          throw new Error("Automation occurrence key was reused with different provenance");
        }
        await tx
          .insert(schema.automationRunEventLinks)
          .values({
            runId: row.id,
            eventId: input.eventId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            triggerId: input.triggerId,
          })
          .onConflictDoNothing();
        return { run: mapRunExecution(row), duplicate: !inserted };
      }),
  );
}

export async function listAutomationRuns(
  db: Database,
  workspaceId: string,
  limit = 100,
): Promise<AutomationRun[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select()
        .from(schema.automationRuns)
        .where(eq(schema.automationRuns.workspaceId, workspaceId))
        .orderBy(desc(schema.automationRuns.createdAt))
        .limit(Math.max(1, Math.min(limit, 200)))
    ).map(mapRun),
  );
}

export async function getAutomationRunExecution(
  db: Database,
  input: { accountId: string; workspaceId: string; runId: string },
): Promise<AutomationRunExecution | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.automationRuns)
      .where(
        and(
          eq(schema.automationRuns.accountId, input.accountId),
          eq(schema.automationRuns.workspaceId, input.workspaceId),
          eq(schema.automationRuns.id, input.runId),
        ),
      )
      .limit(1);
    return row ? mapRunExecution(row) : null;
  });
}

export async function claimAutomationRun(
  db: Database,
  input: { accountId: string; workspaceId: string; runId: string },
): Promise<AutomationRunExecution | null> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.automationRuns)
          .where(
            and(
              eq(schema.automationRuns.accountId, input.accountId),
              eq(schema.automationRuns.workspaceId, input.workspaceId),
              eq(schema.automationRuns.id, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row) return null;
        if (row.status === "dispatched" || row.status === "skipped" || row.status === "failed") {
          return mapRunExecution(row);
        }
        const [updated] = await tx
          .update(schema.automationRuns)
          .set({
            status: "dispatching",
            errorCode: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.automationRuns.id, row.id))
          .returning();
        return updated ? mapRunExecution(updated) : null;
      }),
  );
}

export async function assertAutomationRunAuthorityInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    triggerId: string;
    triggerRevision: number;
    sourceId: string;
    sourceVersion: number;
    sessionId: string;
  },
): Promise<void> {
  const [row] = await db
    .select({
      runStatus: schema.automationRuns.status,
      sourceStatus: schema.automationSources.status,
      sourceVersion: schema.automationSources.version,
      triggerStatus: schema.automationTriggers.status,
      currentRevision: schema.automationTriggers.currentRevision,
      packInstallationId: schema.automationTriggers.packInstallationId,
    })
    .from(schema.automationRuns)
    .innerJoin(
      schema.automationSources,
      eq(schema.automationSources.id, schema.automationRuns.sourceId),
    )
    .innerJoin(
      schema.automationTriggers,
      eq(schema.automationTriggers.id, schema.automationRuns.triggerId),
    )
    .where(
      and(
        eq(schema.automationRuns.workspaceId, input.workspaceId),
        eq(schema.automationRuns.id, input.runId),
        eq(schema.automationRuns.triggerId, input.triggerId),
        eq(schema.automationRuns.triggerRevision, input.triggerRevision),
        eq(schema.automationRuns.sourceId, input.sourceId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !row ||
    row.runStatus !== "dispatching" ||
    row.sourceStatus !== "active" ||
    row.triggerStatus !== "active"
  ) {
    throw new AutomationAuthorityRevokedError();
  }
  if (row.sourceVersion !== input.sourceVersion) {
    throw new AutomationAuthorityRevokedError("Automation source changed before dispatch");
  }
  if (row.currentRevision !== input.triggerRevision) {
    throw new AutomationAuthorityRevokedError("Automation trigger changed before dispatch");
  }
  if (row.packInstallationId) {
    const [installation] = await db
      .select({ status: schema.packInstallations.status })
      .from(schema.packInstallations)
      .where(
        and(
          eq(schema.packInstallations.workspaceId, input.workspaceId),
          eq(schema.packInstallations.id, row.packInstallationId),
        ),
      )
      .limit(1);
    if (!installation || installation.status !== "active") {
      throw new AutomationAuthorityRevokedError("Automation Pack is no longer active");
    }
  }
  await db
    .update(schema.automationRuns)
    .set({
      status: "dispatched",
      sessionId: input.sessionId,
      errorCode: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.automationRuns.id, input.runId));
}

export async function settleAutomationRun(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    status: "skipped" | "failed";
    errorCode: string;
  },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    await scoped
      .update(schema.automationRuns)
      .set({
        status: input.status,
        errorCode: input.errorCode.slice(0, 512),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.automationRuns.workspaceId, input.workspaceId),
          eq(schema.automationRuns.id, input.runId),
          inArray(schema.automationRuns.status, ["queued", "dispatching", "failed"]),
        ),
      );
  });
}

function mapSource(row: SourceRow): AutomationSource {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    adapterId: row.adapterId,
    configuration: row.configuration,
    status: row.status as AutomationSource["status"],
    version: row.version,
    packInstallationId: row.packInstallationId,
    packConnectorId: row.packConnectorId,
    hasWebhookSecret: Boolean(row.webhookSecretEncrypted),
    webhookPath: `/v1/webhooks/automations/${row.endpointId}`,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapTrigger(
  head: TriggerRow,
  revision: RevisionRow,
  revisionNumber = head.currentRevision,
): AutomationTrigger {
  return {
    id: head.id,
    accountId: head.accountId,
    workspaceId: head.workspaceId,
    sourceId: head.sourceId,
    name: head.name,
    adapterId: revision.adapterId,
    eventTypes: revision.eventTypes,
    configuration: revision.configuration,
    parameters: revision.parameters,
    sessionTemplate: AutomationSessionTemplate.parse(revision.sessionTemplate),
    status: head.status as AutomationTrigger["status"],
    revision: revisionNumber,
    packInstallationId: head.packInstallationId,
    packTemplateId: head.packTemplateId,
    createdBySubjectId: head.createdBySubjectId,
    createdAt: head.createdAt.toISOString(),
    updatedAt: head.updatedAt.toISOString(),
  };
}

function mapEvent(row: EventRow): AutomationStoredEvent {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceConfiguration: row.sourceConfiguration,
    matchedTriggerRevisions: row.matchedTriggerRevisions,
    deliveryKey: row.deliveryKey,
    requestDigest: row.requestDigest,
    normalizedEvent: AutomationNormalizedEvent.parse(row.normalizedEvent),
    status: row.status as AutomationStoredEvent["status"],
    ignoredReason: row.ignoredReason,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    triggerId: row.triggerId,
    triggerRevision: row.triggerRevision,
    eventId: row.eventId,
    occurrenceKey: row.occurrenceKey,
    status: row.status as AutomationRun["status"],
    sessionId: row.sessionId,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRunExecution(row: RunRow): AutomationRunExecution {
  return {
    ...mapRun(row),
    acceptedExecution: AutomationAcceptedExecution.parse(row.acceptedExecution),
  };
}
