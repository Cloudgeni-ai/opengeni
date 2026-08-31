import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  AUTOMATION_WEBHOOK_MAX_BYTES,
  AUTOMATION_MAX_MATCHED_TRIGGERS,
  AutomationNormalizedEvent,
  AutomationWebhookResult,
  CreateAutomationSourceRequest,
  CreateAutomationTriggerRequest,
  TriggerAutomationManuallyRequest,
  UpdateAutomationSourceRequest,
  UpdateAutomationTriggerRequest,
  stableJson,
} from "@opengeni/contracts";
import {
  AutomationDeliveryConflictError,
  AutomationRevisionConflictError,
  createAutomationRun,
  createAutomationSource,
  createAutomationTrigger,
  decryptVariableSetValue,
  encryptVariableSetValue,
  getAutomationSourceSecret,
  getAutomationTriggerRevisions,
  listActiveAutomationTriggersForSource,
  listAutomationRuns,
  listAutomationSources,
  listAutomationTriggers,
  lockActiveWorkspaceGatewayCustomModelForAdmission,
  lockActiveWorkspaceOpenRouterCustomModelForAdmission,
  recordAutomationEvent,
  resolveAutomationWebhookEndpoint,
  updateAutomationSource,
  updateAutomationTrigger,
  withWorkspaceGatewayCustomModelReadLock,
  withWorkspaceOpenRouterCustomModelReadLock,
  type AutomationSourceSecret,
} from "@opengeni/db";
import {
  automationRequestDigest,
  assertWorkspaceModelPolicyAllows,
  buildAutomationAcceptedExecution,
  canonicalConfiguredModel,
  workspaceCustomModelReference,
  requireAccessGrant,
  requireAutomationAdapter,
  requirePermission,
  resolveWorkspaceCatalogSettings,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerAutomationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/automations/sources", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json({
      sources: await listAutomationSources(deps.db, workspaceId),
    });
  });

  app.post("/v1/workspaces/:workspaceId/automations/sources", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    requirePermission(grant, "secrets:write");
    const request = CreateAutomationSourceRequest.parse(await c.req.json());
    requireAutomationAdapter(request.adapterId).validateSourceConfiguration(request.configuration);
    const key = requireEncryptionKey(deps);
    const source = await createAutomationSource(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      createdBySubjectId: grant.subjectId,
      request,
      webhookSecretEncrypted: encryptVariableSetValue(key, request.webhookSecret),
    });
    return c.json(source, 201);
  });

  app.patch("/v1/workspaces/:workspaceId/automations/sources/:sourceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const request = UpdateAutomationSourceRequest.parse(await c.req.json());
    const current = await requireSource(
      deps,
      grant.accountId,
      workspaceId,
      c.req.param("sourceId"),
    );
    assertGenericSourceMutable(current);
    if (request.configuration) {
      requireAutomationAdapter(current.adapterId).validateSourceConfiguration(
        request.configuration,
      );
    }
    let webhookSecretEncrypted: string | undefined;
    if (request.webhookSecret !== undefined) {
      requirePermission(grant, "secrets:write");
      webhookSecretEncrypted = encryptVariableSetValue(
        requireEncryptionKey(deps),
        request.webhookSecret,
      );
    }
    const source = await updateAutomationSource(deps.db, {
      workspaceId,
      sourceId: current.id,
      request,
      ...(webhookSecretEncrypted ? { webhookSecretEncrypted } : {}),
    });
    if (!source)
      throw new HTTPException(404, {
        message: "automation source not found",
      });
    return c.json(source);
  });

  app.delete("/v1/workspaces/:workspaceId/automations/sources/:sourceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const current = await requireSource(
      deps,
      grant.accountId,
      workspaceId,
      c.req.param("sourceId"),
    );
    assertGenericSourceMutable(current);
    const source = await updateAutomationSource(deps.db, {
      workspaceId,
      sourceId: c.req.param("sourceId"),
      request: { status: "disabled" },
    });
    if (!source)
      throw new HTTPException(404, {
        message: "automation source not found",
      });
    return c.body(null, 204);
  });

  app.get("/v1/workspaces/:workspaceId/automations/triggers", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json({
      triggers: await listAutomationTriggers(deps.db, workspaceId),
    });
  });

  app.post("/v1/workspaces/:workspaceId/automations/triggers", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const request = CreateAutomationTriggerRequest.parse(await c.req.json());
    if (request.packInstallationId || request.packTemplateId) {
      throw new HTTPException(409, {
        message: "Pack-owned automation triggers must be created through their Pack setup API",
      });
    }
    const source = await requireSource(deps, grant.accountId, workspaceId, request.sourceId);
    assertGenericSourceMutable(source);
    if (source.status !== "active") {
      throw new HTTPException(409, {
        message: "automation source is disabled",
      });
    }
    const adapter = requireAutomationAdapter(source.adapterId);
    adapter.validateTriggerConfiguration(request.configuration);
    adapter.validateTriggerParameters(request.parameters);
    for (const permission of request.sessionTemplate.firstPartyMcpPermissions) {
      requirePermission(grant, permission);
    }
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(deps.db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
      })
    ).settings;
    const model = canonicalConfiguredModel(catalogSettings, request.sessionTemplate.model) ?? null;
    if (model) {
      await assertWorkspaceModelPolicyAllows(deps.db, catalogSettings, workspaceId, model);
    }
    const normalizedRequest = {
      ...request,
      sessionTemplate: { ...request.sessionTemplate, model },
    };
    const beforeCreateCommit = model
      ? workspaceCustomModelCommitGuard({
          settings: catalogSettings,
          accountId: grant.accountId,
          workspaceId,
          modelId: model,
        })
      : undefined;
    return c.json(
      await createAutomationTrigger(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        createdBySubjectId: grant.subjectId,
        request: normalizedRequest,
        adapterId: adapter.id,
        ...(beforeCreateCommit ? { beforeCreateCommit } : {}),
      }),
      201,
    );
  });

  app.patch("/v1/workspaces/:workspaceId/automations/triggers/:triggerId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const request = UpdateAutomationTriggerRequest.parse(await c.req.json());
    const existing = (await listAutomationTriggers(deps.db, workspaceId)).find(
      (trigger) => trigger.id === c.req.param("triggerId"),
    );
    if (!existing)
      throw new HTTPException(404, {
        message: "automation trigger not found",
      });
    assertGenericTriggerMutable(existing);
    if (request.configuration) {
      requireAutomationAdapter(existing.adapterId).validateTriggerConfiguration(
        request.configuration,
      );
    }
    if (request.parameters) {
      requireAutomationAdapter(existing.adapterId).validateTriggerParameters(request.parameters);
    }
    if (request.sessionTemplate) {
      for (const permission of request.sessionTemplate.firstPartyMcpPermissions) {
        requirePermission(grant, permission);
      }
    }
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(deps.db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
      })
    ).settings;
    const normalizedRequest = request.sessionTemplate
      ? {
          ...request,
          sessionTemplate: {
            ...request.sessionTemplate,
            model: canonicalConfiguredModel(catalogSettings, request.sessionTemplate.model) ?? null,
          },
        }
      : request;
    if (normalizedRequest.sessionTemplate?.model) {
      await assertWorkspaceModelPolicyAllows(
        deps.db,
        catalogSettings,
        workspaceId,
        normalizedRequest.sessionTemplate.model,
      );
    }
    const effectiveModel = normalizedRequest.sessionTemplate
      ? normalizedRequest.sessionTemplate.model
      : existing.sessionTemplate.model;
    const materialExecutionChange =
      request.eventTypes !== undefined ||
      request.configuration !== undefined ||
      request.parameters !== undefined ||
      request.sessionTemplate !== undefined ||
      (request.status === "active" && existing.status !== "active");
    const beforeUpdateCommit =
      materialExecutionChange && effectiveModel
        ? workspaceCustomModelCommitGuard({
            settings: catalogSettings,
            accountId: grant.accountId,
            workspaceId,
            modelId: effectiveModel,
          })
        : undefined;
    try {
      const trigger = await updateAutomationTrigger(deps.db, {
        workspaceId,
        triggerId: c.req.param("triggerId"),
        subjectId: grant.subjectId,
        request: normalizedRequest,
        ...(beforeUpdateCommit ? { beforeUpdateCommit } : {}),
      });
      if (!trigger)
        throw new HTTPException(404, {
          message: "automation trigger not found",
        });
      return c.json(trigger);
    } catch (error) {
      if (error instanceof AutomationRevisionConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.delete("/v1/workspaces/:workspaceId/automations/triggers/:triggerId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const expectedRevision = Number(c.req.query("expectedRevision"));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new HTTPException(400, {
        message: "expectedRevision must be a positive integer",
      });
    }
    const existing = (await listAutomationTriggers(deps.db, workspaceId)).find(
      (trigger) => trigger.id === c.req.param("triggerId"),
    );
    if (!existing)
      throw new HTTPException(404, {
        message: "automation trigger not found",
      });
    assertGenericTriggerMutable(existing);
    try {
      const trigger = await updateAutomationTrigger(deps.db, {
        workspaceId,
        triggerId: c.req.param("triggerId"),
        subjectId: grant.subjectId,
        request: { expectedRevision, status: "disabled" },
      });
      if (!trigger)
        throw new HTTPException(404, {
          message: "automation trigger not found",
        });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AutomationRevisionConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/automations/runs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json({ runs: await listAutomationRuns(deps.db, workspaceId) });
  });

  app.post("/v1/workspaces/:workspaceId/automations/sources/:sourceId/events", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const request = TriggerAutomationManuallyRequest.parse(await c.req.json());
    const source = await requireSource(deps, grant.accountId, workspaceId, c.req.param("sourceId"));
    if (source.status !== "active") {
      throw new HTTPException(409, {
        message: "automation source is disabled",
      });
    }
    const normalizedEvent = AutomationNormalizedEvent.parse({
      adapterId: source.adapterId,
      eventType: request.eventType,
      occurrenceKey: request.occurrenceKey,
      occurredAt: request.occurredAt,
      subject: request.subject,
      resource: request.resource,
      payload: request.payload,
    });
    const bytes = new TextEncoder().encode(stableJson(request));
    return c.json(
      await acceptAutomationEvent(deps, source, {
        deliveryKey:
          request.deliveryId ?? `manual:${automationRequestDigest(source.adapterId, bytes)}`,
        requestDigest: automationRequestDigest(source.adapterId, bytes),
        normalizedEvent,
      }),
      202,
    );
  });

  app.post("/v1/webhooks/automations/:endpointId", async (c) => {
    const endpointId = c.req.param("endpointId");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        endpointId,
      )
    ) {
      throw new HTTPException(404, {
        message: "automation endpoint not found",
      });
    }
    const endpoint = await resolveAutomationWebhookEndpoint(deps.db, endpointId);
    if (!endpoint)
      throw new HTTPException(404, {
        message: "automation endpoint not found",
      });
    const source = await requireSource(
      deps,
      endpoint.accountId,
      endpoint.workspaceId,
      endpoint.sourceId,
    );
    if (source.status !== "active") {
      throw new HTTPException(410, {
        message: "automation source is disabled",
      });
    }
    const rawBody = await readAutomationWebhookBody(c.req.raw, AUTOMATION_WEBHOOK_MAX_BYTES);
    const adapter = requireAutomationAdapter(source.adapterId);
    const secret = decryptVariableSetValue(
      requireEncryptionKey(deps),
      source.webhookSecretEncrypted,
    );
    if (
      !adapter.verify({
        rawBody,
        headers: c.req.raw.headers,
        secret,
        sourceConfiguration: source.configuration,
      })
    ) {
      throw new HTTPException(401, {
        message: "automation signature is invalid",
      });
    }
    const requestDigest = automationRequestDigest(source.adapterId, rawBody);
    try {
      const result = await acceptAutomationEvent(deps, source, {
        deliveryKey: adapter.deliveryKey({
          headers: c.req.raw.headers,
          requestDigest,
        }),
        requestDigest,
        normalizedEvent: adapter.normalize({
          rawBody,
          headers: c.req.raw.headers,
          sourceConfiguration: source.configuration,
        }),
      });
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof AutomationDeliveryConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });
}

export async function acceptAutomationEvent(
  deps: ApiRouteDeps,
  source: AutomationSourceSecret,
  input: {
    deliveryKey: string;
    requestDigest: string;
    normalizedEvent: AutomationNormalizedEvent;
  },
) {
  if (input.normalizedEvent.adapterId !== source.adapterId) {
    throw new HTTPException(422, {
      message: "automation event adapter does not match source",
    });
  }
  const adapter = requireAutomationAdapter(source.adapterId);
  const triggers = await listActiveAutomationTriggersForSource(deps.db, {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
  });
  const matchingByEvent = triggers.filter((trigger) =>
    adapter.matches({ event: input.normalizedEvent, trigger }),
  );
  if (matchingByEvent.length > AUTOMATION_MAX_MATCHED_TRIGGERS) {
    throw new HTTPException(422, {
      message: `automation event matches more than ${AUTOMATION_MAX_MATCHED_TRIGGERS} triggers`,
    });
  }
  const stored =
    matchingByEvent.length === 0
      ? await recordAutomationEvent(deps.db, {
          accountId: source.accountId,
          workspaceId: source.workspaceId,
          sourceId: source.id,
          sourceVersion: source.version,
          sourceConfiguration: source.configuration,
          matchedTriggerRevisions: [],
          deliveryKey: input.deliveryKey,
          requestDigest: input.requestDigest,
          normalizedEvent: input.normalizedEvent,
          ignoredReason: "no_matching_triggers",
        })
      : await withWorkspaceGatewayCustomModelReadLock(
          deps.db,
          { accountId: source.accountId, workspaceId: source.workspaceId },
          async (gatewayLockedDb) =>
            await withWorkspaceOpenRouterCustomModelReadLock(
              gatewayLockedDb,
              { accountId: source.accountId, workspaceId: source.workspaceId },
              async (lockedDb) => {
                const catalogSourceSettings = deps.catalogSourceSettings ?? deps.settings;
                const catalogSettings = (
                  await resolveWorkspaceCatalogSettings(lockedDb, catalogSourceSettings, {
                    accountId: source.accountId,
                    workspaceId: source.workspaceId,
                  })
                ).settings;
                const matchingAtAcceptance = [];
                for (const trigger of matchingByEvent) {
                  try {
                    const render = adapter.render({
                      event: input.normalizedEvent,
                      trigger,
                      source,
                    });
                    const requestedModel =
                      render.sessionTemplate.model ?? catalogSettings.openaiModel;
                    const model = canonicalConfiguredModel(catalogSettings, requestedModel);
                    if (!model) continue;
                    await assertWorkspaceModelPolicyAllows(
                      lockedDb,
                      catalogSettings,
                      source.workspaceId,
                      model,
                    );
                    matchingAtAcceptance.push(trigger);
                  } catch (error) {
                    if (isUnprocessableEntity(error)) continue;
                    throw error;
                  }
                }
                return await recordAutomationEvent(lockedDb, {
                  accountId: source.accountId,
                  workspaceId: source.workspaceId,
                  sourceId: source.id,
                  sourceVersion: source.version,
                  sourceConfiguration: source.configuration,
                  matchedTriggerRevisions: matchingAtAcceptance.map((trigger) => ({
                    triggerId: trigger.id,
                    revision: trigger.revision,
                  })),
                  deliveryKey: input.deliveryKey,
                  requestDigest: input.requestDigest,
                  normalizedEvent: input.normalizedEvent,
                  ignoredReason:
                    matchingAtAcceptance.length === 0 ? "no_executable_triggers" : null,
                });
              },
            ),
        );
  const matching = await getAutomationTriggerRevisions(deps.db, {
    workspaceId: source.workspaceId,
    refs: stored.event.matchedTriggerRevisions,
  });
  const acceptedSource = {
    ...source,
    version: stored.event.sourceVersion,
    configuration: stored.event.sourceConfiguration,
  };
  const runIds: string[] = [];
  const triggerAutomationRun = deps.workflowClient.triggerAutomationRun;
  if (matching.length > 0 && !triggerAutomationRun) {
    throw new HTTPException(503, {
      message: "automation dispatcher is unavailable",
    });
  }
  for (const trigger of matching) {
    const render = adapter.render({
      event: stored.event.normalizedEvent,
      trigger,
      source: acceptedSource,
    });
    const acceptedExecution = buildAutomationAcceptedExecution({
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      source: acceptedSource,
      trigger,
      eventId: stored.event.id,
      event: stored.event.normalizedEvent,
      render,
    });
    const { run } = await createAutomationRun(deps.db, {
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      triggerId: trigger.id,
      triggerRevision: trigger.revision,
      eventId: stored.event.id,
      occurrenceKey: stored.event.normalizedEvent.occurrenceKey,
      acceptedExecution,
    });
    runIds.push(run.id);
    await triggerAutomationRun!({
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      runId: run.id,
    });
  }
  return AutomationWebhookResult.parse({
    accepted: true,
    duplicate: stored.duplicate,
    ignoredReason: stored.event.ignoredReason,
    eventId: stored.event.id,
    runIds,
  });
}

function isUnprocessableEntity(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as Error & { status?: unknown }).status === 422
  );
}

function workspaceCustomModelCommitGuard(input: {
  settings: ApiRouteDeps["settings"];
  accountId: string;
  workspaceId: string;
  modelId: string;
}): ((tx: ApiRouteDeps["db"]) => Promise<void>) | undefined {
  const reference = workspaceCustomModelReference(input.settings, input.modelId);
  if (!reference) return undefined;
  return async (tx): Promise<void> => {
    const active =
      reference.providerKind === "openrouter"
        ? await lockActiveWorkspaceOpenRouterCustomModelForAdmission(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            upstreamModelId: reference.upstreamModelId,
          })
        : await lockActiveWorkspaceGatewayCustomModelForAdmission(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            upstreamModelId: reference.upstreamModelId,
          });
    if (!active) {
      throw new HTTPException(422, {
        message: `model is not available: ${input.modelId}`,
      });
    }
  };
}

async function requireSource(
  deps: ApiRouteDeps,
  accountId: string,
  workspaceId: string,
  sourceId: string,
): Promise<AutomationSourceSecret> {
  const source = await getAutomationSourceSecret(deps.db, {
    accountId,
    workspaceId,
    sourceId,
  });
  if (!source) throw new HTTPException(404, { message: "automation source not found" });
  return source;
}

function assertGenericSourceMutable(source: AutomationSourceSecret): void {
  if (source.packInstallationId) {
    throw new HTTPException(409, {
      message: "Pack-owned automation sources must be managed through their Pack setup API",
    });
  }
}

function assertGenericTriggerMutable(trigger: { packInstallationId: string | null }): void {
  if (trigger.packInstallationId) {
    throw new HTTPException(409, {
      message: "Pack-owned automation triggers must be managed through their Pack setup API",
    });
  }
}

function requireEncryptionKey(deps: ApiRouteDeps): Uint8Array {
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) {
    throw new HTTPException(503, {
      message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for automations",
    });
  }
  return key;
}

export async function readAutomationWebhookBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HTTPException(413, {
      message: "automation webhook payload is too large",
    });
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new HTTPException(413, {
        message: "automation webhook payload is too large",
      });
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
