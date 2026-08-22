import {
  AutomationSessionTemplate,
  OPENGENI_PR_REVIEW_PACK_ID,
  OPENGENI_PR_REVIEW_SESSION_ROLE,
  type PrReviewAppRegistration,
  type PrReviewProvider,
  type PrReviewRepositoryBinding,
} from "@opengeni/contracts";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";

export type PrReviewAppRegistrationSecret = PrReviewAppRegistration & {
  credentialEncrypted: string | null;
};

export class PrReviewDispatchAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrReviewDispatchAuthorityError";
  }
}

export async function createPrReviewAppRegistration(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    provider: PrReviewProvider;
    providerBaseUrl: string;
    appId: string | null;
    credentialKind: "github_app" | "provider_token";
    credentialEncrypted: string | null;
    accessTokenExpiresAt: Date | null;
    webhookAuthKind: "hmac_sha256" | "shared_token" | "basic";
    webhookSecretEncrypted: string;
    webhookUsername: string | null;
    createdBySubjectId: string;
  },
): Promise<PrReviewAppRegistration> {
  return await withRlsContext(db, input, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const registrationId = randomUUID();
      const [source] = await tx
        .insert(schema.automationSources)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: `${input.name} webhooks`,
          adapterId: "source-control.pull-request.v1",
          configuration: {
            provider: input.provider,
            providerBaseUrl: input.providerBaseUrl,
            registrationId,
            webhookUsername: input.webhookUsername,
          },
          webhookSecretEncrypted: input.webhookSecretEncrypted,
          createdBySubjectId: input.createdBySubjectId,
        })
        .returning();
      if (!source) throw new Error("Failed to create PR Review automation source");
      await tx.insert(schema.automationWebhookEndpoints).values({
        endpointId: source.endpointId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceId: source.id,
      });
      const [row] = await tx
        .insert(schema.prReviewAppRegistrations)
        .values({
          id: registrationId,
          sourceId: source.id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: input.name,
          provider: input.provider,
          providerBaseUrl: input.providerBaseUrl,
          appId: input.appId,
          credentialKind: input.credentialKind,
          credentialEncrypted: input.credentialEncrypted,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          webhookAuthKind: input.webhookAuthKind,
          webhookUsername: input.webhookUsername,
          createdBySubjectId: input.createdBySubjectId,
        })
        .returning();
      if (!row) throw new Error("Failed to create PR Review app registration");
      return mapRegistration(row, source.endpointId);
    });
  });
}

export async function listPrReviewAppRegistrations(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<PrReviewAppRegistration[]> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        registration: schema.prReviewAppRegistrations,
        endpointId: schema.automationSources.endpointId,
      })
      .from(schema.prReviewAppRegistrations)
      .innerJoin(
        schema.automationSources,
        and(
          eq(schema.automationSources.workspaceId, schema.prReviewAppRegistrations.workspaceId),
          eq(schema.automationSources.id, schema.prReviewAppRegistrations.sourceId),
        ),
      )
      .where(eq(schema.prReviewAppRegistrations.workspaceId, workspaceId))
      .orderBy(desc(schema.prReviewAppRegistrations.updatedAt));
    return rows.map(({ registration, endpointId }) => mapRegistration(registration, endpointId));
  });
}

export async function getPrReviewAppRegistrationSecret(
  db: Database,
  input: { accountId: string; workspaceId: string; registrationId: string },
): Promise<PrReviewAppRegistrationSecret | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [result] = await scopedDb
      .select({
        registration: schema.prReviewAppRegistrations,
        endpointId: schema.automationSources.endpointId,
      })
      .from(schema.prReviewAppRegistrations)
      .innerJoin(
        schema.automationSources,
        and(
          eq(schema.automationSources.workspaceId, schema.prReviewAppRegistrations.workspaceId),
          eq(schema.automationSources.id, schema.prReviewAppRegistrations.sourceId),
        ),
      )
      .where(
        and(
          eq(schema.prReviewAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.prReviewAppRegistrations.id, input.registrationId),
        ),
      )
      .limit(1);
    const row = result?.registration;
    return row
      ? {
          ...mapRegistration(row, result.endpointId),
          credentialEncrypted: row.credentialEncrypted,
        }
      : null;
  });
}

export async function updatePrReviewAppRegistration(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    name?: string;
    credentialEncrypted?: string;
    accessTokenExpiresAt?: Date | null;
    webhookSecretEncrypted?: string;
    webhookUsername?: string;
    status?: "active" | "disabled";
  },
): Promise<PrReviewAppRegistration | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.prReviewAppRegistrations)
        .where(
          and(
            eq(schema.prReviewAppRegistrations.workspaceId, input.workspaceId),
            eq(schema.prReviewAppRegistrations.id, input.registrationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!existing) return null;
      const nextConfiguration = {
        provider: existing.provider,
        providerBaseUrl: existing.providerBaseUrl,
        registrationId: existing.id,
        webhookUsername: input.webhookUsername ?? existing.webhookUsername,
      };
      const sourceChanges =
        input.name !== undefined ||
        input.webhookSecretEncrypted !== undefined ||
        input.webhookUsername !== undefined ||
        input.status !== undefined;
      const [source] = sourceChanges
        ? await tx
            .update(schema.automationSources)
            .set({
              ...(input.name !== undefined ? { name: `${input.name} webhooks` } : {}),
              ...(input.webhookSecretEncrypted !== undefined
                ? { webhookSecretEncrypted: input.webhookSecretEncrypted }
                : {}),
              ...(input.webhookUsername !== undefined ? { configuration: nextConfiguration } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              version: sql`${schema.automationSources.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.automationSources.workspaceId, input.workspaceId),
                eq(schema.automationSources.id, existing.sourceId),
              ),
            )
            .returning()
        : await tx
            .select()
            .from(schema.automationSources)
            .where(eq(schema.automationSources.id, existing.sourceId))
            .limit(1);
      if (!source)
        throw new PrReviewDispatchAuthorityError("PR Review automation source is unavailable");
      const [row] = await tx
        .update(schema.prReviewAppRegistrations)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.credentialEncrypted !== undefined
            ? { credentialEncrypted: input.credentialEncrypted }
            : {}),
          ...(input.accessTokenExpiresAt !== undefined
            ? { accessTokenExpiresAt: input.accessTokenExpiresAt }
            : {}),
          ...(input.webhookUsername !== undefined
            ? { webhookUsername: input.webhookUsername }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.prReviewAppRegistrations.workspaceId, input.workspaceId),
            eq(schema.prReviewAppRegistrations.id, input.registrationId),
          ),
        )
        .returning();
      return row ? mapRegistration(row, source.endpointId) : null;
    });
  });
}

export async function deletePrReviewAppRegistration(
  db: Database,
  input: { accountId: string; workspaceId: string; registrationId: string },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const [registration] = await tx
        .update(schema.prReviewAppRegistrations)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(
          and(
            eq(schema.prReviewAppRegistrations.workspaceId, input.workspaceId),
            eq(schema.prReviewAppRegistrations.id, input.registrationId),
          ),
        )
        .returning({ sourceId: schema.prReviewAppRegistrations.sourceId });
      if (!registration) return false;
      await tx
        .update(schema.automationSources)
        .set({
          status: "disabled",
          version: sql`${schema.automationSources.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.automationSources.id, registration.sourceId));
      return true;
    });
  });
}

export async function createPrReviewRepositoryBinding(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    provider: PrReviewProvider;
    repositoryUri: string;
    repositoryFullName: string;
    providerRepositoryId: string;
    installationId: string | null;
    projectId: string | null;
    model: string | null;
    additionalInstructions: string | null;
    status: "active" | "disabled";
    createdBySubjectId: string;
    packInstallationId: string;
    packTemplateId: string;
    adapterId: string;
    eventTypes: string[];
    configuration: Record<string, unknown>;
    sessionTemplate: AutomationSessionTemplate;
  },
): Promise<PrReviewRepositoryBinding> {
  return await withRlsContext(db, input, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const [registration] = await tx
        .select({
          provider: schema.prReviewAppRegistrations.provider,
          sourceId: schema.prReviewAppRegistrations.sourceId,
          status: schema.prReviewAppRegistrations.status,
        })
        .from(schema.prReviewAppRegistrations)
        .where(
          and(
            eq(schema.prReviewAppRegistrations.workspaceId, input.workspaceId),
            eq(schema.prReviewAppRegistrations.id, input.registrationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!registration || registration.status !== "active") {
        throw new PrReviewDispatchAuthorityError("PR Review app registration is unavailable");
      }
      if (registration.provider !== input.provider) {
        throw new PrReviewDispatchAuthorityError(
          "PR Review repository provider does not match its app",
        );
      }
      const bindingId = randomUUID();
      const [trigger] = await tx
        .insert(schema.automationTriggers)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: registration.sourceId,
          name: `Review ${input.repositoryFullName}`,
          status: input.status,
          packInstallationId: input.packInstallationId,
          packTemplateId: input.packTemplateId,
          createdBySubjectId: input.createdBySubjectId,
        })
        .returning();
      if (!trigger) throw new Error("Failed to create PR Review automation trigger");
      await tx.insert(schema.automationTriggerRevisions).values({
        triggerId: trigger.id,
        revision: 1,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        adapterId: input.adapterId,
        eventTypes: input.eventTypes,
        configuration: input.configuration,
        parameters: prReviewTriggerParameters(input, bindingId),
        sessionTemplate: input.sessionTemplate,
        createdBySubjectId: input.createdBySubjectId,
      });
      const [row] = await tx
        .insert(schema.prReviewRepositoryBindings)
        .values({
          id: bindingId,
          triggerId: trigger.id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          registrationId: input.registrationId,
          provider: input.provider,
          repositoryUri: input.repositoryUri,
          repositoryFullName: input.repositoryFullName,
          providerRepositoryId: input.providerRepositoryId,
          installationId: input.installationId,
          projectId: input.projectId,
          model: input.model,
          additionalInstructions: input.additionalInstructions,
          status: input.status,
          createdBySubjectId: input.createdBySubjectId,
        })
        .returning();
      if (!row) throw new Error("Failed to create PR Review repository binding");
      return mapRepositoryBinding(row);
    });
  });
}

export async function listPrReviewRepositoryBindings(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<PrReviewRepositoryBinding[]> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.prReviewRepositoryBindings)
      .where(eq(schema.prReviewRepositoryBindings.workspaceId, workspaceId))
      .orderBy(desc(schema.prReviewRepositoryBindings.updatedAt));
    return rows.map(mapRepositoryBinding);
  });
}

export async function updatePrReviewRepositoryBinding(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    bindingId: string;
    subjectId: string;
    model?: string | null;
    additionalInstructions?: string | null;
    status?: "active" | "disabled";
  },
): Promise<PrReviewRepositoryBinding | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const [current] = await tx
        .select({
          binding: schema.prReviewRepositoryBindings,
          trigger: schema.automationTriggers,
          revision: schema.automationTriggerRevisions,
        })
        .from(schema.prReviewRepositoryBindings)
        .innerJoin(
          schema.automationTriggers,
          and(
            eq(
              schema.automationTriggers.workspaceId,
              schema.prReviewRepositoryBindings.workspaceId,
            ),
            eq(schema.automationTriggers.id, schema.prReviewRepositoryBindings.triggerId),
          ),
        )
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
            eq(schema.prReviewRepositoryBindings.workspaceId, input.workspaceId),
            eq(schema.prReviewRepositoryBindings.id, input.bindingId),
          ),
        )
        .limit(1)
        .for("update", { of: schema.automationTriggers });
      if (!current) return null;
      const next = {
        ...current.binding,
        model: input.model === undefined ? current.binding.model : input.model,
        additionalInstructions:
          input.additionalInstructions === undefined
            ? current.binding.additionalInstructions
            : input.additionalInstructions,
        status: input.status ?? (current.binding.status as "active" | "disabled"),
      };
      const nextRevision = current.trigger.currentRevision + 1;
      await tx.insert(schema.automationTriggerRevisions).values({
        triggerId: current.trigger.id,
        revision: nextRevision,
        accountId: current.trigger.accountId,
        workspaceId: current.trigger.workspaceId,
        adapterId: current.revision.adapterId,
        eventTypes: current.revision.eventTypes,
        configuration: current.revision.configuration,
        parameters: prReviewTriggerParameters(next, current.binding.id),
        sessionTemplate: current.revision.sessionTemplate,
        createdBySubjectId: input.subjectId,
      });
      await tx
        .update(schema.automationTriggers)
        .set({
          currentRevision: nextRevision,
          status: next.status,
          updatedAt: new Date(),
        })
        .where(eq(schema.automationTriggers.id, current.trigger.id));
      const [row] = await tx
        .update(schema.prReviewRepositoryBindings)
        .set({
          model: next.model,
          additionalInstructions: next.additionalInstructions,
          status: next.status,
          updatedAt: new Date(),
        })
        .where(eq(schema.prReviewRepositoryBindings.id, current.binding.id))
        .returning();
      return row ? mapRepositoryBinding(row) : null;
    });
  });
}

export async function deletePrReviewRepositoryBinding(
  db: Database,
  input: { accountId: string; workspaceId: string; bindingId: string; subjectId: string },
): Promise<boolean> {
  return (
    (await updatePrReviewRepositoryBinding(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      bindingId: input.bindingId,
      subjectId: input.subjectId,
      status: "disabled",
    })) !== null
  );
}

export async function resolvePrReviewGitCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    provider: PrReviewProvider;
    sessionId: string;
    rootSessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    repositoryRefs: Array<{
      uri: string;
      expectedCommitSha?: string;
      repositoryId?: string | number;
      installationId?: string | number;
      projectId?: string | number;
    }>;
  },
): Promise<{
  credentialKind: "github_app" | "provider_token";
  appId: string | null;
  credentialEncrypted: string | null;
  expiresAt: string | null;
}> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [authority] = await scopedDb
      .select({
        sessionId: schema.sessions.id,
        rootSessionId: schema.sessions.rootSessionId,
        activeTurnId: schema.sessions.activeTurnId,
        sessionMetadata: schema.sessions.metadata,
        sessionResources: schema.sessions.resources,
        policyRole: schema.sessions.policyRole,
        createdByKind: schema.sessions.createdByKind,
        createdBySubjectId: schema.sessions.createdBySubjectId,
        turnId: schema.sessionTurns.id,
        turnGeneration: schema.sessionTurns.executionGeneration,
        activeAttemptId: schema.sessionTurns.activeAttemptId,
        turnInitiatorKind: schema.sessionTurns.initiatorKind,
        turnInitiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
        attemptId: schema.sessionTurnAttempts.id,
        attemptState: schema.sessionTurnAttempts.state,
        attemptGeneration: schema.sessionTurnAttempts.executionGeneration,
      })
      .from(schema.sessions)
      .innerJoin(
        schema.sessionTurns,
        and(
          eq(schema.sessionTurns.workspaceId, schema.sessions.workspaceId),
          eq(schema.sessionTurns.sessionId, schema.sessions.id),
          eq(schema.sessionTurns.id, input.turnId),
        ),
      )
      .innerJoin(
        schema.sessionTurnAttempts,
        and(
          eq(schema.sessionTurnAttempts.workspaceId, schema.sessions.workspaceId),
          eq(schema.sessionTurnAttempts.sessionId, schema.sessions.id),
          eq(schema.sessionTurnAttempts.turnId, schema.sessionTurns.id),
          eq(schema.sessionTurnAttempts.id, input.attemptId),
        ),
      )
      .where(
        and(
          eq(schema.sessions.accountId, input.accountId),
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .limit(1);
    const metadata = authority?.sessionMetadata;
    const bindingId = prReviewMetadataText(metadata, "prReviewRepositoryBindingId");
    const expectedHeadSha = prReviewMetadataText(metadata, "prReviewHeadSha");
    const automationRunId = prReviewMetadataText(metadata, "automationRunId");
    const automationTriggerId = prReviewMetadataText(metadata, "automationTriggerId");
    const exactRepositoryResource = prReviewExactRepositoryResource(
      authority?.sessionResources,
      input.repositoryRefs,
      input.registrationId,
      input.provider,
    );
    if (
      !authority ||
      authority.rootSessionId !== input.rootSessionId ||
      authority.sessionId !== input.rootSessionId ||
      authority.activeTurnId !== input.turnId ||
      authority.turnId !== input.turnId ||
      authority.turnGeneration !== input.executionGeneration ||
      authority.attemptGeneration !== input.executionGeneration ||
      authority.activeAttemptId !== input.attemptId ||
      authority.attemptId !== input.attemptId ||
      !["claimed", "running"].includes(authority.attemptState) ||
      authority.policyRole !== OPENGENI_PR_REVIEW_SESSION_ROLE ||
      authority.createdByKind !== "service" ||
      authority.createdBySubjectId !== `automation:${automationTriggerId}` ||
      authority.turnInitiatorKind !== "service" ||
      authority.turnInitiatorSubjectId !== `automation:${automationTriggerId}` ||
      prReviewMetadataText(metadata, "role") !== OPENGENI_PR_REVIEW_SESSION_ROLE ||
      prReviewMetadataText(metadata, "prReviewRegistrationId") !== input.registrationId ||
      !bindingId ||
      !automationRunId ||
      !automationTriggerId ||
      !expectedHeadSha ||
      !exactRepositoryResource ||
      exactRepositoryResource.expectedCommitSha !== expectedHeadSha
    ) {
      throw new PrReviewDispatchAuthorityError(
        "PR Review credential requires an exact live PR Review attempt",
      );
    }
    const [execution] = await scopedDb
      .select({
        runStatus: schema.automationRuns.status,
        runSessionId: schema.automationRuns.sessionId,
        triggerStatus: schema.automationTriggers.status,
        sourceStatus: schema.automationSources.status,
        packStatus: schema.packInstallations.status,
        bindingStatus: schema.prReviewRepositoryBindings.status,
        registrationStatus: schema.prReviewAppRegistrations.status,
      })
      .from(schema.automationRuns)
      .innerJoin(
        schema.automationTriggers,
        and(
          eq(schema.automationTriggers.workspaceId, schema.automationRuns.workspaceId),
          eq(schema.automationTriggers.id, schema.automationRuns.triggerId),
        ),
      )
      .innerJoin(
        schema.automationSources,
        and(
          eq(schema.automationSources.workspaceId, schema.automationRuns.workspaceId),
          eq(schema.automationSources.id, schema.automationRuns.sourceId),
        ),
      )
      .innerJoin(
        schema.prReviewRepositoryBindings,
        and(
          eq(schema.prReviewRepositoryBindings.workspaceId, schema.automationRuns.workspaceId),
          eq(schema.prReviewRepositoryBindings.triggerId, schema.automationRuns.triggerId),
        ),
      )
      .innerJoin(
        schema.prReviewAppRegistrations,
        and(
          eq(schema.prReviewAppRegistrations.workspaceId, schema.automationRuns.workspaceId),
          eq(schema.prReviewAppRegistrations.id, schema.prReviewRepositoryBindings.registrationId),
          eq(schema.prReviewAppRegistrations.sourceId, schema.automationRuns.sourceId),
        ),
      )
      .innerJoin(
        schema.packInstallations,
        and(
          eq(schema.packInstallations.workspaceId, schema.automationRuns.workspaceId),
          eq(schema.packInstallations.id, schema.automationTriggers.packInstallationId),
        ),
      )
      .where(
        and(
          eq(schema.automationRuns.workspaceId, input.workspaceId),
          eq(schema.automationRuns.id, automationRunId),
          eq(schema.automationRuns.triggerId, automationTriggerId),
          eq(schema.automationRuns.sessionId, input.sessionId),
          eq(schema.prReviewRepositoryBindings.id, bindingId),
          eq(schema.prReviewAppRegistrations.id, input.registrationId),
          eq(schema.packInstallations.packId, OPENGENI_PR_REVIEW_PACK_ID),
        ),
      )
      .limit(1);
    if (
      !execution ||
      !["dispatching", "dispatched"].includes(execution.runStatus) ||
      execution.runSessionId !== input.sessionId ||
      execution.triggerStatus !== "active" ||
      execution.sourceStatus !== "active" ||
      execution.packStatus !== "active" ||
      execution.bindingStatus !== "active" ||
      execution.registrationStatus !== "active"
    ) {
      throw new PrReviewDispatchAuthorityError("PR Review automation authority is unavailable");
    }
    const [registration] = await scopedDb
      .select()
      .from(schema.prReviewAppRegistrations)
      .where(
        and(
          eq(schema.prReviewAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.prReviewAppRegistrations.id, input.registrationId),
          eq(schema.prReviewAppRegistrations.provider, input.provider),
          eq(schema.prReviewAppRegistrations.status, "active"),
        ),
      )
      .limit(1);
    if (!registration)
      throw new PrReviewDispatchAuthorityError("PR Review credential registration is unavailable");
    const bindings = await scopedDb
      .select()
      .from(schema.prReviewRepositoryBindings)
      .where(
        and(
          eq(schema.prReviewRepositoryBindings.workspaceId, input.workspaceId),
          eq(schema.prReviewRepositoryBindings.registrationId, input.registrationId),
          eq(schema.prReviewRepositoryBindings.id, bindingId),
          eq(schema.prReviewRepositoryBindings.provider, input.provider),
          eq(schema.prReviewRepositoryBindings.status, "active"),
        ),
      );
    for (const reference of input.repositoryRefs) {
      const repositoryId =
        reference.repositoryId === undefined ? null : String(reference.repositoryId);
      const installationId =
        reference.installationId === undefined ? null : String(reference.installationId);
      const projectId = reference.projectId === undefined ? null : String(reference.projectId);
      const exact = bindings.find(
        (binding) =>
          binding.repositoryUri === reference.uri &&
          repositoryId !== null &&
          binding.providerRepositoryId === repositoryId &&
          (binding.installationId === null || binding.installationId === installationId) &&
          (binding.projectId === null || binding.projectId === projectId),
      );
      if (!exact)
        throw new PrReviewDispatchAuthorityError(
          "PR Review credential is not authorized for this repository",
        );
    }
    const [pack] = await scopedDb
      .select({ status: schema.packInstallations.status })
      .from(schema.packInstallations)
      .where(
        and(
          eq(schema.packInstallations.workspaceId, input.workspaceId),
          eq(schema.packInstallations.packId, OPENGENI_PR_REVIEW_PACK_ID),
        ),
      )
      .limit(1);
    if (pack?.status !== "active")
      throw new PrReviewDispatchAuthorityError("OpenGeni Review Bot Pack is not active");
    return {
      credentialKind: registration.credentialKind as "github_app" | "provider_token",
      appId: registration.appId,
      credentialEncrypted: registration.credentialEncrypted,
      expiresAt: registration.accessTokenExpiresAt?.toISOString() ?? null,
    };
  });
}

function prReviewMetadataText(metadata: unknown, key: string): string | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function prReviewExactRepositoryResource(
  resources: unknown,
  repositoryRefs: Array<{
    uri: string;
    expectedCommitSha?: string;
    repositoryId?: string | number;
    installationId?: string | number;
    projectId?: string | number;
  }>,
  registrationId: string,
  provider: PrReviewProvider,
): Record<string, unknown> | null {
  if (!Array.isArray(resources) || repositoryRefs.length !== 1) return null;
  const repositories = resources.filter(
    (resource): resource is Record<string, unknown> =>
      typeof resource === "object" &&
      resource !== null &&
      !Array.isArray(resource) &&
      (resource as Record<string, unknown>).kind === "repository",
  );
  if (repositories.length !== 1) return null;
  const resource = repositories[0]!;
  const reference = repositoryRefs[0]!;
  const sameOptionalIdentity = (key: "repositoryId" | "installationId" | "projectId") =>
    resource[key] === undefined
      ? reference[key] === undefined
      : String(resource[key]) === String(reference[key]);
  return resource.uri === reference.uri &&
    resource.expectedCommitSha === reference.expectedCommitSha &&
    resource.provider === provider &&
    resource.credentialBindingId === `pr-review:${registrationId}` &&
    sameOptionalIdentity("repositoryId") &&
    sameOptionalIdentity("installationId") &&
    sameOptionalIdentity("projectId")
    ? resource
    : null;
}

function prReviewTriggerParameters(
  input: {
    registrationId: string;
    provider: PrReviewProvider | string;
    repositoryUri: string;
    repositoryFullName: string;
    providerRepositoryId: string;
    installationId: string | null;
    projectId: string | null;
    model: string | null;
    additionalInstructions: string | null;
  },
  repositoryBindingId: string,
): Record<string, unknown> {
  return {
    registrationId: input.registrationId,
    repositoryBindingId,
    provider: input.provider,
    repositoryUri: input.repositoryUri,
    repositoryFullName: input.repositoryFullName,
    providerRepositoryId: input.providerRepositoryId,
    installationId: input.installationId,
    projectId: input.projectId,
    model: input.model,
    additionalInstructions: input.additionalInstructions,
  };
}

function mapRegistration(
  row: typeof schema.prReviewAppRegistrations.$inferSelect,
  endpointId: string,
): PrReviewAppRegistration {
  return {
    id: row.id,
    sourceId: row.sourceId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    provider: row.provider as PrReviewProvider,
    providerBaseUrl: row.providerBaseUrl,
    appId: row.appId,
    credentialKind: row.credentialKind as "github_app" | "provider_token",
    hasCredential: row.credentialEncrypted !== null,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.toISOString() ?? null,
    webhookAuthKind: row.webhookAuthKind as "hmac_sha256" | "shared_token" | "basic",
    hasWebhookSecret: true,
    webhookUsername: row.webhookUsername,
    webhookPath: `/v1/webhooks/automations/${endpointId}`,
    status: row.status as "active" | "disabled",
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRepositoryBinding(
  row: typeof schema.prReviewRepositoryBindings.$inferSelect,
): PrReviewRepositoryBinding {
  return {
    id: row.id,
    triggerId: row.triggerId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    registrationId: row.registrationId,
    provider: row.provider as PrReviewProvider,
    repositoryUri: row.repositoryUri,
    repositoryFullName: row.repositoryFullName,
    providerRepositoryId: row.providerRepositoryId,
    installationId: row.installationId,
    projectId: row.projectId,
    model: row.model,
    additionalInstructions: row.additionalInstructions,
    status: row.status as "active" | "disabled",
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
