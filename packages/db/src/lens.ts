import {
  OPENGENI_LENS_PACK_ID,
  OPENGENI_LENS_SESSION_ROLE,
  type LensAppRegistration,
  type LensProvider,
  type LensRepositoryBinding,
} from "@opengeni/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";

export type LensAppRegistrationSecret = LensAppRegistration & {
  credentialEncrypted: string | null;
  webhookSecretEncrypted: string;
};

export type LensWebhookDelivery = {
  id: string;
  accountId: string;
  workspaceId: string;
  registrationId: string;
  repositoryBindingId: string;
  provider: LensProvider;
  deliveryKey: string;
  requestDigest: string;
  eventName: string;
  action: string | null;
  pullRequestId: string | null;
  headSha: string | null;
  baseSha: string | null;
  status: "pending" | "dispatched" | "ignored" | "failed";
  ignoredReason: string | null;
  errorCode: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export class LensDeliveryConflictError extends Error {
  constructor() {
    super("Lens delivery key was already used for a different request");
    this.name = "LensDeliveryConflictError";
  }
}

export class LensDispatchAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LensDispatchAuthorityError";
  }
}

export async function createLensAppRegistration(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    provider: LensProvider;
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
): Promise<LensAppRegistration> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.lensAppRegistrations).values(input).returning();
    if (!row) throw new Error("Failed to create Lens app registration");
    return mapRegistration(row);
  });
}

export async function listLensAppRegistrations(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<LensAppRegistration[]> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.lensAppRegistrations)
      .where(eq(schema.lensAppRegistrations.workspaceId, workspaceId))
      .orderBy(desc(schema.lensAppRegistrations.updatedAt));
    return rows.map(mapRegistration);
  });
}

export async function getLensAppRegistrationSecret(
  db: Database,
  input: { accountId: string; workspaceId: string; registrationId: string },
): Promise<LensAppRegistrationSecret | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.lensAppRegistrations)
      .where(
        and(
          eq(schema.lensAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.lensAppRegistrations.id, input.registrationId),
        ),
      )
      .limit(1);
    return row
      ? {
          ...mapRegistration(row),
          credentialEncrypted: row.credentialEncrypted,
          webhookSecretEncrypted: row.webhookSecretEncrypted,
        }
      : null;
  });
}

export async function updateLensAppRegistration(
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
): Promise<LensAppRegistration | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.lensAppRegistrations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.credentialEncrypted !== undefined
          ? { credentialEncrypted: input.credentialEncrypted }
          : {}),
        ...(input.accessTokenExpiresAt !== undefined
          ? { accessTokenExpiresAt: input.accessTokenExpiresAt }
          : {}),
        ...(input.webhookSecretEncrypted !== undefined
          ? { webhookSecretEncrypted: input.webhookSecretEncrypted }
          : {}),
        ...(input.webhookUsername !== undefined ? { webhookUsername: input.webhookUsername } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.lensAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.lensAppRegistrations.id, input.registrationId),
        ),
      )
      .returning();
    return row ? mapRegistration(row) : null;
  });
}

export async function deleteLensAppRegistration(
  db: Database,
  input: { accountId: string; workspaceId: string; registrationId: string },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .update(schema.lensAppRegistrations)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(
        and(
          eq(schema.lensAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.lensAppRegistrations.id, input.registrationId),
        ),
      )
      .returning({ id: schema.lensAppRegistrations.id });
    return rows.length > 0;
  });
}

export async function createLensRepositoryBinding(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    provider: LensProvider;
    repositoryUri: string;
    repositoryFullName: string;
    providerRepositoryId: string;
    installationId: string | null;
    projectId: string | null;
    model: string | null;
    additionalInstructions: string | null;
    status: "active" | "disabled";
    createdBySubjectId: string;
  },
): Promise<LensRepositoryBinding> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [registration] = await scopedDb
      .select({ provider: schema.lensAppRegistrations.provider })
      .from(schema.lensAppRegistrations)
      .where(
        and(
          eq(schema.lensAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.lensAppRegistrations.id, input.registrationId),
        ),
      )
      .limit(1);
    if (!registration) throw new LensDispatchAuthorityError("Lens app registration not found");
    if (registration.provider !== input.provider) {
      throw new LensDispatchAuthorityError("Lens repository provider does not match its app");
    }
    const [row] = await scopedDb.insert(schema.lensRepositoryBindings).values(input).returning();
    if (!row) throw new Error("Failed to create Lens repository binding");
    return mapRepositoryBinding(row);
  });
}

export async function listLensRepositoryBindings(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<LensRepositoryBinding[]> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.lensRepositoryBindings)
      .where(eq(schema.lensRepositoryBindings.workspaceId, workspaceId))
      .orderBy(desc(schema.lensRepositoryBindings.updatedAt));
    return rows.map(mapRepositoryBinding);
  });
}

export async function updateLensRepositoryBinding(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    bindingId: string;
    model?: string | null;
    additionalInstructions?: string | null;
    status?: "active" | "disabled";
  },
): Promise<LensRepositoryBinding | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.lensRepositoryBindings)
      .set({
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.additionalInstructions !== undefined
          ? { additionalInstructions: input.additionalInstructions }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.lensRepositoryBindings.workspaceId, input.workspaceId),
          eq(schema.lensRepositoryBindings.id, input.bindingId),
        ),
      )
      .returning();
    return row ? mapRepositoryBinding(row) : null;
  });
}

export async function deleteLensRepositoryBinding(
  db: Database,
  input: { accountId: string; workspaceId: string; bindingId: string },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .update(schema.lensRepositoryBindings)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(
        and(
          eq(schema.lensRepositoryBindings.workspaceId, input.workspaceId),
          eq(schema.lensRepositoryBindings.id, input.bindingId),
        ),
      )
      .returning({ id: schema.lensRepositoryBindings.id });
    return rows.length > 0;
  });
}

export async function getLensRepositoryBindingForProviderEvent(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    providerRepositoryId: string;
  },
): Promise<LensRepositoryBinding | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.lensRepositoryBindings)
      .where(
        and(
          eq(schema.lensRepositoryBindings.workspaceId, input.workspaceId),
          eq(schema.lensRepositoryBindings.registrationId, input.registrationId),
          eq(schema.lensRepositoryBindings.providerRepositoryId, input.providerRepositoryId),
        ),
      )
      .limit(1);
    return row ? mapRepositoryBinding(row) : null;
  });
}

export async function recordLensWebhookDelivery(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    repositoryBindingId: string;
    provider: LensProvider;
    deliveryKey: string;
    requestDigest: string;
    eventName: string;
    action: string | null;
    pullRequestId: string | null;
    headSha: string | null;
    baseSha: string | null;
    ignoredReason?: string | null;
  },
): Promise<{ delivery: LensWebhookDelivery; duplicate: boolean }> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [inserted] = await scopedDb
      .insert(schema.lensWebhookDeliveries)
      .values({
        ...input,
        status: input.ignoredReason ? "ignored" : "pending",
        ignoredReason: input.ignoredReason ?? null,
      })
      .onConflictDoNothing({
        target: [
          schema.lensWebhookDeliveries.registrationId,
          schema.lensWebhookDeliveries.deliveryKey,
        ],
      })
      .returning();
    if (inserted) return { delivery: mapDelivery(inserted), duplicate: false };
    const [existing] = await scopedDb
      .select()
      .from(schema.lensWebhookDeliveries)
      .where(
        and(
          eq(schema.lensWebhookDeliveries.registrationId, input.registrationId),
          eq(schema.lensWebhookDeliveries.deliveryKey, input.deliveryKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Failed to record Lens webhook delivery");
    if (existing.requestDigest !== input.requestDigest) throw new LensDeliveryConflictError();
    return { delivery: mapDelivery(existing), duplicate: true };
  });
}

export async function completeLensWebhookDelivery(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    deliveryId: string;
    sessionId: string;
  },
): Promise<void> {
  await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb
      .update(schema.lensWebhookDeliveries)
      .set({
        status: "dispatched",
        sessionId: input.sessionId,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.lensWebhookDeliveries.workspaceId, input.workspaceId),
          eq(schema.lensWebhookDeliveries.id, input.deliveryId),
          inArray(schema.lensWebhookDeliveries.status, ["pending", "failed"]),
        ),
      );
  });
}

export async function failLensWebhookDelivery(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    deliveryId: string;
    errorCode: string;
  },
): Promise<void> {
  await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb
      .update(schema.lensWebhookDeliveries)
      .set({ status: "failed", errorCode: input.errorCode.slice(0, 200), updatedAt: new Date() })
      .where(
        and(
          eq(schema.lensWebhookDeliveries.workspaceId, input.workspaceId),
          eq(schema.lensWebhookDeliveries.id, input.deliveryId),
          inArray(schema.lensWebhookDeliveries.status, ["pending", "failed"]),
        ),
      );
  });
}

/** Recheck every mutable Lens authority inside the session-create transaction. */
export async function assertLensDispatchAuthorityInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    registrationId: string;
    repositoryBindingId: string;
    providerRepositoryId: string;
  },
): Promise<void> {
  const [row] = await db
    .select({
      registrationStatus: schema.lensAppRegistrations.status,
      bindingStatus: schema.lensRepositoryBindings.status,
      providerRepositoryId: schema.lensRepositoryBindings.providerRepositoryId,
      packStatus: schema.packInstallations.status,
    })
    .from(schema.lensRepositoryBindings)
    .innerJoin(
      schema.lensAppRegistrations,
      and(
        eq(schema.lensAppRegistrations.workspaceId, schema.lensRepositoryBindings.workspaceId),
        eq(schema.lensAppRegistrations.id, schema.lensRepositoryBindings.registrationId),
      ),
    )
    .innerJoin(
      schema.packInstallations,
      and(
        eq(schema.packInstallations.workspaceId, schema.lensRepositoryBindings.workspaceId),
        eq(schema.packInstallations.packId, OPENGENI_LENS_PACK_ID),
      ),
    )
    .where(
      and(
        eq(schema.lensRepositoryBindings.workspaceId, input.workspaceId),
        eq(schema.lensRepositoryBindings.id, input.repositoryBindingId),
        eq(schema.lensRepositoryBindings.registrationId, input.registrationId),
      ),
    )
    .limit(1);
  if (!row || row.packStatus !== "active") {
    throw new LensDispatchAuthorityError("OpenGeni Lens Pack is not active");
  }
  if (row.registrationStatus !== "active" || row.bindingStatus !== "active") {
    throw new LensDispatchAuthorityError("OpenGeni Lens app or repository binding is disabled");
  }
  if (row.providerRepositoryId !== input.providerRepositoryId) {
    throw new LensDispatchAuthorityError("OpenGeni Lens repository identity changed");
  }
}

export async function resolveLensGitCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    registrationId: string;
    provider: LensProvider;
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
    const bindingId = lensMetadataText(metadata, "lensRepositoryBindingId");
    const deliveryId = lensMetadataText(metadata, "lensDeliveryId");
    const expectedHeadSha = lensMetadataText(metadata, "lensHeadSha");
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
      authority.policyRole !== OPENGENI_LENS_SESSION_ROLE ||
      authority.createdByKind !== "service" ||
      authority.createdBySubjectId !== "opengeni-lens" ||
      authority.turnInitiatorKind !== "service" ||
      authority.turnInitiatorSubjectId !== "opengeni-lens" ||
      lensMetadataText(metadata, "role") !== OPENGENI_LENS_SESSION_ROLE ||
      lensMetadataText(metadata, "lensRegistrationId") !== input.registrationId ||
      !bindingId ||
      !deliveryId ||
      deliveryId !== input.sessionId ||
      !expectedHeadSha ||
      input.repositoryRefs.length !== 1 ||
      input.repositoryRefs[0]?.expectedCommitSha !== expectedHeadSha
    ) {
      throw new LensDispatchAuthorityError("Lens credential requires an exact live Lens attempt");
    }
    const [delivery] = await scopedDb
      .select({
        registrationId: schema.lensWebhookDeliveries.registrationId,
        repositoryBindingId: schema.lensWebhookDeliveries.repositoryBindingId,
        provider: schema.lensWebhookDeliveries.provider,
        headSha: schema.lensWebhookDeliveries.headSha,
        status: schema.lensWebhookDeliveries.status,
      })
      .from(schema.lensWebhookDeliveries)
      .where(
        and(
          eq(schema.lensWebhookDeliveries.workspaceId, input.workspaceId),
          eq(schema.lensWebhookDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    if (
      !delivery ||
      delivery.registrationId !== input.registrationId ||
      delivery.repositoryBindingId !== bindingId ||
      delivery.provider !== input.provider ||
      delivery.headSha !== expectedHeadSha ||
      !["pending", "dispatched", "failed"].includes(delivery.status)
    ) {
      throw new LensDispatchAuthorityError("Lens delivery authority is unavailable");
    }
    const [registration] = await scopedDb
      .select()
      .from(schema.lensAppRegistrations)
      .where(
        and(
          eq(schema.lensAppRegistrations.workspaceId, input.workspaceId),
          eq(schema.lensAppRegistrations.id, input.registrationId),
          eq(schema.lensAppRegistrations.provider, input.provider),
          eq(schema.lensAppRegistrations.status, "active"),
        ),
      )
      .limit(1);
    if (!registration)
      throw new LensDispatchAuthorityError("Lens credential registration is unavailable");
    const bindings = await scopedDb
      .select()
      .from(schema.lensRepositoryBindings)
      .where(
        and(
          eq(schema.lensRepositoryBindings.workspaceId, input.workspaceId),
          eq(schema.lensRepositoryBindings.registrationId, input.registrationId),
          eq(schema.lensRepositoryBindings.id, bindingId),
          eq(schema.lensRepositoryBindings.provider, input.provider),
          eq(schema.lensRepositoryBindings.status, "active"),
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
        throw new LensDispatchAuthorityError(
          "Lens credential is not authorized for this repository",
        );
    }
    const [pack] = await scopedDb
      .select({ status: schema.packInstallations.status })
      .from(schema.packInstallations)
      .where(
        and(
          eq(schema.packInstallations.workspaceId, input.workspaceId),
          eq(schema.packInstallations.packId, OPENGENI_LENS_PACK_ID),
        ),
      )
      .limit(1);
    if (pack?.status !== "active")
      throw new LensDispatchAuthorityError("OpenGeni Lens Pack is not active");
    return {
      credentialKind: registration.credentialKind as "github_app" | "provider_token",
      appId: registration.appId,
      credentialEncrypted: registration.credentialEncrypted,
      expiresAt: registration.accessTokenExpiresAt?.toISOString() ?? null,
    };
  });
}

function lensMetadataText(metadata: unknown, key: string): string | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapRegistration(
  row: typeof schema.lensAppRegistrations.$inferSelect,
): LensAppRegistration {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    provider: row.provider as LensProvider,
    providerBaseUrl: row.providerBaseUrl,
    appId: row.appId,
    credentialKind: row.credentialKind as "github_app" | "provider_token",
    hasCredential: row.credentialEncrypted !== null,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.toISOString() ?? null,
    webhookAuthKind: row.webhookAuthKind as "hmac_sha256" | "shared_token" | "basic",
    hasWebhookSecret: true,
    webhookUsername: row.webhookUsername,
    webhookPath: `/v1/webhooks/lens/${row.accountId}/${row.workspaceId}/${row.id}`,
    status: row.status as "active" | "disabled",
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRepositoryBinding(
  row: typeof schema.lensRepositoryBindings.$inferSelect,
): LensRepositoryBinding {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    registrationId: row.registrationId,
    provider: row.provider as LensProvider,
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

function mapDelivery(row: typeof schema.lensWebhookDeliveries.$inferSelect): LensWebhookDelivery {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    registrationId: row.registrationId,
    repositoryBindingId: row.repositoryBindingId,
    provider: row.provider as LensProvider,
    deliveryKey: row.deliveryKey,
    requestDigest: row.requestDigest,
    eventName: row.eventName,
    action: row.action,
    pullRequestId: row.pullRequestId,
    headSha: row.headSha,
    baseSha: row.baseSha,
    status: row.status as LensWebhookDelivery["status"],
    ignoredReason: row.ignoredReason,
    errorCode: row.errorCode,
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
