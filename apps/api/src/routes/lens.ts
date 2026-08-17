import { createHash } from "node:crypto";
import { environmentsEncryptionKeyBytes, resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  CreateLensAppRegistrationRequest,
  CreateLensRepositoryBindingRequest,
  LensAppRegistration,
  LensRepositoryBinding,
  LensWebhookResult,
  OPENGENI_LENS_PACK_ID,
  UpdateLensAppRegistrationRequest,
  UpdateLensRepositoryBindingRequest,
  type LensProvider,
} from "@opengeni/contracts";
import {
  assertWorkspaceModelPolicyAllows,
  canonicalConfiguredModel,
  createAndStartSessionWithOutcome,
  defaultLensProviderBaseUrl,
  lensCredentialBindingId,
  lensReviewPrompt,
  lensSessionMetadata,
  lensWebhookAuthKind,
  normalizeLensProviderBaseUrl,
  normalizeLensPullRequestEvent,
  OPENGENI_LENS_AGENT_INSTRUCTIONS,
  OPENGENI_LENS_SKILL,
  recordWorkspaceUsage,
  requireAccessGrant,
  requireLimit,
  requirePermission,
  verifyLensWebhook,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  assertLensDispatchAuthorityInTransaction,
  completeLensWebhookDelivery,
  createLensAppRegistration,
  createLensRepositoryBinding,
  deleteLensAppRegistration,
  deleteLensRepositoryBinding,
  decryptVariableSetValue,
  encryptVariableSetValue,
  failLensWebhookDelivery,
  getLensAppRegistrationSecret,
  getLensRepositoryBindingForProviderEvent,
  getPackInstallation,
  LensDeliveryConflictError,
  LensDispatchAuthorityError,
  listLensAppRegistrations,
  listLensRepositoryBindings,
  nestedPostgresSqlState,
  recordLensWebhookDelivery,
  recordAuditEvent,
  updateLensAppRegistration,
  updateLensRepositoryBinding,
} from "@opengeni/db";
import { listGitHubAppRepositoriesWithSigningSettings } from "@opengeni/github";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  LensProviderRepositoryError,
  verifyLensProviderRepository,
} from "../integrations/lens-provider";

const LENS_WEBHOOK_MAX_BYTES = 2 * 1024 * 1024;

export function registerLensRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;

  app.get("/v1/workspaces/:workspaceId/lens/registrations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await requireLensPackActive(db, workspaceId);
    return c.json({
      registrations: await listLensAppRegistrations(db, grant.accountId, workspaceId),
      repositories: await listLensRepositoryBindings(db, grant.accountId, workspaceId),
    });
  });

  app.post("/v1/workspaces/:workspaceId/lens/registrations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    requirePermission(grant, "secrets:write");
    await requireLensPackActive(db, workspaceId);
    assertLensSandboxBackend(deps);
    const payload = CreateLensAppRegistrationRequest.parse(await c.req.json());
    const encryptionKey = requireLensEncryptionKey(deps);
    let providerBaseUrl: string;
    try {
      providerBaseUrl = normalizeLensProviderBaseUrl(
        payload.provider,
        payload.providerBaseUrl ?? defaultLensProviderBaseUrl(payload.provider),
      );
    } catch (error) {
      throw new HTTPException(422, {
        message:
          error instanceof Error
            ? error.message
            : "Lens providerBaseUrl must be a credential-free HTTPS origin or path",
      });
    }
    if (
      payload.provider === "azure_devops" &&
      new URL(providerBaseUrl).pathname.split("/").filter(Boolean).length === 0
    ) {
      throw new HTTPException(422, {
        message: "Azure DevOps Lens providerBaseUrl must include the organization path",
      });
    }
    const registration = await mapLensUniqueConflict(
      createLensAppRegistration(db, {
        accountId: grant.accountId,
        workspaceId,
        name: payload.name,
        provider: payload.provider,
        providerBaseUrl,
        appId: payload.appId ?? null,
        credentialKind: payload.credentialKind,
        credentialEncrypted: encryptVariableSetValue(
          encryptionKey,
          payload.privateKey ?? payload.accessToken!,
        ),
        accessTokenExpiresAt: payload.accessTokenExpiresAt
          ? new Date(payload.accessTokenExpiresAt)
          : null,
        webhookAuthKind: lensWebhookAuthKind(payload.provider),
        webhookSecretEncrypted: encryptVariableSetValue(encryptionKey, payload.webhookSecret),
        webhookUsername: payload.webhookUsername ?? null,
        createdBySubjectId: grant.subjectId,
      }),
      "A Lens registration with this provider and name already exists",
    );
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "lens.app_registration.created",
      targetType: "lens_app_registration",
      targetId: registration.id,
      metadata: {
        provider: registration.provider,
        credentialKind: registration.credentialKind,
        webhookAuthKind: registration.webhookAuthKind,
      },
    });
    return c.json(LensAppRegistration.parse(registration), 201);
  });

  app.patch("/v1/workspaces/:workspaceId/lens/registrations/:registrationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    requirePermission(grant, "secrets:write");
    await requireLensPackActive(db, workspaceId);
    const payload = UpdateLensAppRegistrationRequest.parse(await c.req.json());
    const existing = await getLensAppRegistrationSecret(db, {
      accountId: grant.accountId,
      workspaceId,
      registrationId: c.req.param("registrationId"),
    });
    if (!existing)
      throw new HTTPException(404, {
        message: "Lens app registration not found",
      });
    if (payload.accessToken && existing.credentialKind !== "provider_token") {
      throw new HTTPException(422, {
        message: "GitHub App registrations accept private keys, not access tokens",
      });
    }
    if (payload.privateKey && existing.credentialKind !== "github_app") {
      throw new HTTPException(422, {
        message: "Provider-token registrations do not accept GitHub private keys",
      });
    }
    if (
      payload.accessTokenExpiresAt !== undefined &&
      existing.credentialKind !== "provider_token"
    ) {
      throw new HTTPException(422, {
        message: "GitHub App registrations do not accept access-token expiry",
      });
    }
    const encryptionKey =
      payload.privateKey || payload.accessToken || payload.webhookSecret
        ? requireLensEncryptionKey(deps)
        : null;
    const updated = await mapLensUniqueConflict(
      updateLensAppRegistration(db, {
        accountId: grant.accountId,
        workspaceId,
        registrationId: existing.id,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.accessToken !== undefined
          ? {
              credentialEncrypted: encryptVariableSetValue(encryptionKey!, payload.accessToken),
            }
          : {}),
        ...(payload.privateKey !== undefined
          ? {
              credentialEncrypted: encryptVariableSetValue(encryptionKey!, payload.privateKey),
            }
          : {}),
        ...(payload.accessTokenExpiresAt !== undefined
          ? {
              accessTokenExpiresAt: payload.accessTokenExpiresAt
                ? new Date(payload.accessTokenExpiresAt)
                : null,
            }
          : {}),
        ...(payload.webhookSecret !== undefined
          ? {
              webhookSecretEncrypted: encryptVariableSetValue(
                encryptionKey!,
                payload.webhookSecret,
              ),
            }
          : {}),
        ...(payload.webhookUsername !== undefined
          ? { webhookUsername: payload.webhookUsername }
          : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      }),
      "A Lens registration with this provider and name already exists",
    );
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "lens.app_registration.updated",
      targetType: "lens_app_registration",
      targetId: existing.id,
      metadata: {
        fields: Object.keys(payload).filter(
          (field) => field !== "accessToken" && field !== "privateKey" && field !== "webhookSecret",
        ),
        credentialRotated: payload.accessToken !== undefined || payload.privateKey !== undefined,
        webhookSecretRotated: payload.webhookSecret !== undefined,
      },
    });
    return c.json(LensAppRegistration.parse(updated));
  });

  app.delete("/v1/workspaces/:workspaceId/lens/registrations/:registrationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const deleted = await deleteLensAppRegistration(db, {
      accountId: grant.accountId,
      workspaceId,
      registrationId: c.req.param("registrationId"),
    });
    if (!deleted)
      throw new HTTPException(404, {
        message: "Lens app registration not found",
      });
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "lens.app_registration.disabled",
      targetType: "lens_app_registration",
      targetId: c.req.param("registrationId"),
      metadata: {},
    });
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/lens/repositories", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    await requireLensPackActive(db, workspaceId);
    const payload = CreateLensRepositoryBindingRequest.parse(await c.req.json());
    const registration = await getLensAppRegistrationSecret(db, {
      accountId: grant.accountId,
      workspaceId,
      registrationId: payload.registrationId,
    });
    if (!registration)
      throw new HTTPException(404, {
        message: "Lens app registration not found",
      });
    const repositoryUrl = new URL(payload.repositoryUri);
    let canonicalRepositoryUri = repositoryUrl.href;
    let canonicalRepositoryFullName = payload.repositoryFullName;
    let canonicalProviderRepositoryId = String(payload.providerRepositoryId);
    let canonicalProjectId = payload.projectId === undefined ? null : String(payload.projectId);
    const providerUrl = new URL(registration.providerBaseUrl);
    const providerPath = providerUrl.pathname.replace(/\/$/, "");
    if (
      repositoryUrl.protocol !== "https:" ||
      repositoryUrl.username ||
      repositoryUrl.password ||
      repositoryUrl.host.toLowerCase() !== providerUrl.host.toLowerCase() ||
      (providerPath !== "" &&
        providerPath !== "/" &&
        !repositoryUrl.pathname.startsWith(`${providerPath}/`))
    ) {
      throw new HTTPException(422, {
        message:
          "repositoryUri must be a credential-free HTTPS URL on the registered provider host",
      });
    }
    if (registration.provider === "github") {
      const installationId = positiveInteger(payload.installationId);
      const repositoryId = positiveInteger(payload.providerRepositoryId);
      if (!installationId || !repositoryId || !registration.appId) {
        throw new HTTPException(422, {
          message: "GitHub repository bindings require App, installation, and repository IDs",
        });
      }
      const encryptionKey = requireLensEncryptionKey(deps);
      if (!registration.credentialEncrypted) {
        throw new HTTPException(409, {
          message: "Lens GitHub App credential is unavailable",
        });
      }
      let allowedRepositories;
      try {
        allowedRepositories = await listGitHubAppRepositoriesWithSigningSettings(
          {
            githubAppId: registration.appId,
            githubAppPrivateKey: decryptVariableSetValue(
              encryptionKey,
              registration.credentialEncrypted,
            ),
          },
          { installationIds: [installationId] },
        );
      } catch {
        throw new HTTPException(502, {
          message: "Could not verify the repository against the registered GitHub App",
        });
      }
      const allowedRepository = allowedRepositories.find(
        (candidate) =>
          candidate.id === repositoryId &&
          candidate.fullName.toLowerCase() === payload.repositoryFullName.toLowerCase(),
      );
      if (!allowedRepository) {
        throw new HTTPException(403, {
          message: "GitHub repository is not installed for this Lens App",
        });
      }
      canonicalRepositoryUri = allowedRepository.cloneUrl;
      canonicalRepositoryFullName = allowedRepository.fullName;
      canonicalProviderRepositoryId = String(allowedRepository.id);
    }
    if (registration.provider !== "github") {
      if (
        registration.accessTokenExpiresAt &&
        Date.parse(registration.accessTokenExpiresAt) <= Date.now()
      ) {
        throw new HTTPException(409, {
          message: "Lens provider credential has expired",
        });
      }
      const encryptionKey = requireLensEncryptionKey(deps);
      if (!registration.credentialEncrypted) {
        throw new HTTPException(409, {
          message: "Lens provider credential is unavailable",
        });
      }
      try {
        const verified = await verifyLensProviderRepository({
          provider: registration.provider,
          providerBaseUrl: registration.providerBaseUrl,
          providerRepositoryId: String(payload.providerRepositoryId),
          ...(payload.projectId !== undefined ? { projectId: String(payload.projectId) } : {}),
          token: decryptVariableSetValue(encryptionKey, registration.credentialEncrypted),
          username: registration.webhookUsername,
          settings,
        });
        canonicalRepositoryUri = verified.repositoryUri;
        canonicalRepositoryFullName = verified.repositoryFullName;
        canonicalProviderRepositoryId = verified.providerRepositoryId;
        canonicalProjectId = verified.projectId;
      } catch (error) {
        if (error instanceof LensProviderRepositoryError) {
          const status =
            error.reason === "denied" ? 403 : error.reason === "identity_mismatch" ? 422 : 502;
          throw new HTTPException(status, { message: error.message });
        }
        throw error;
      }
    }
    const model = payload.model
      ? (canonicalConfiguredModel(settings, payload.model) ?? null)
      : null;
    if (model) await assertWorkspaceModelPolicyAllows(db, settings, workspaceId, model);
    const binding = await mapLensUniqueConflict(
      createLensRepositoryBinding(db, {
        accountId: grant.accountId,
        workspaceId,
        registrationId: registration.id,
        provider: registration.provider,
        repositoryUri: canonicalRepositoryUri,
        repositoryFullName: canonicalRepositoryFullName,
        providerRepositoryId: canonicalProviderRepositoryId,
        installationId:
          payload.installationId === undefined ? null : String(payload.installationId),
        projectId: canonicalProjectId,
        model,
        additionalInstructions: payload.additionalInstructions ?? null,
        status: payload.status,
        createdBySubjectId: grant.subjectId,
      }),
      "This repository is already bound to the selected Lens registration",
    );
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "lens.repository_binding.created",
      targetType: "lens_repository_binding",
      targetId: binding.id,
      metadata: {
        provider: binding.provider,
        registrationId: binding.registrationId,
        providerRepositoryId: binding.providerRepositoryId,
      },
    });
    return c.json(LensRepositoryBinding.parse(binding), 201);
  });

  app.patch("/v1/workspaces/:workspaceId/lens/repositories/:bindingId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    await requireLensPackActive(db, workspaceId);
    const payload = UpdateLensRepositoryBindingRequest.parse(await c.req.json());
    const model =
      payload.model === undefined
        ? undefined
        : payload.model === null
          ? null
          : (canonicalConfiguredModel(settings, payload.model) ?? null);
    if (model) await assertWorkspaceModelPolicyAllows(db, settings, workspaceId, model);
    const binding = await updateLensRepositoryBinding(db, {
      accountId: grant.accountId,
      workspaceId,
      bindingId: c.req.param("bindingId"),
      ...(model !== undefined ? { model } : {}),
      ...(payload.additionalInstructions !== undefined
        ? { additionalInstructions: payload.additionalInstructions }
        : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
    });
    if (!binding)
      throw new HTTPException(404, {
        message: "Lens repository binding not found",
      });
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "lens.repository_binding.updated",
      targetType: "lens_repository_binding",
      targetId: binding.id,
      metadata: { fields: Object.keys(payload) },
    });
    return c.json(LensRepositoryBinding.parse(binding));
  });

  app.delete("/v1/workspaces/:workspaceId/lens/repositories/:bindingId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const deleted = await deleteLensRepositoryBinding(db, {
      accountId: grant.accountId,
      workspaceId,
      bindingId: c.req.param("bindingId"),
    });
    if (!deleted)
      throw new HTTPException(404, {
        message: "Lens repository binding not found",
      });
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "lens.repository_binding.disabled",
      targetType: "lens_repository_binding",
      targetId: c.req.param("bindingId"),
      metadata: {},
    });
    return c.body(null, 204);
  });

  app.post("/v1/webhooks/lens/:accountId/:workspaceId/:registrationId", async (c) => {
    const ids = z
      .object({
        accountId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        registrationId: z.string().uuid(),
      })
      .safeParse({
        accountId: c.req.param("accountId"),
        workspaceId: c.req.param("workspaceId"),
        registrationId: c.req.param("registrationId"),
      });
    if (!ids.success) throw new HTTPException(404, { message: "Lens webhook not found" });
    const { accountId, workspaceId, registrationId } = ids.data;
    const registration = await getLensAppRegistrationSecret(db, {
      accountId,
      workspaceId,
      registrationId,
    });
    if (!registration || registration.status !== "active") {
      throw new HTTPException(404, { message: "Lens webhook not found" });
    }
    const body = await readLensWebhookBody(c.req.raw);
    const encryptionKey = requireLensEncryptionKey(deps);
    const webhookSecret = decryptVariableSetValue(
      encryptionKey,
      registration.webhookSecretEncrypted,
    );
    if (
      !verifyLensWebhook({
        provider: registration.provider,
        rawBody: body,
        secret: webhookSecret,
        webhookUsername: registration.webhookUsername,
        headers: c.req.raw.headers,
      })
    ) {
      throw new HTTPException(401, {
        message: "Invalid Lens webhook signature",
      });
    }
    const packInstallation = await getPackInstallation(db, workspaceId, OPENGENI_LENS_PACK_ID);
    if (packInstallation?.status !== "active") {
      return c.json(
        LensWebhookResult.parse({
          accepted: false,
          duplicate: false,
          ignoredReason: "pack_not_active",
          sessionId: null,
        }),
        202,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new HTTPException(400, { message: "Invalid Lens webhook JSON" });
    }
    const eventName = lensEventName(registration.provider, c.req.raw.headers, payload);
    const normalized = normalizeLensPullRequestEvent(registration.provider, eventName, payload);
    if (!normalized.providerRepositoryId) {
      return c.json(
        LensWebhookResult.parse({
          accepted: false,
          duplicate: false,
          ignoredReason: normalized.ignoredReason ?? "repository_identity_unavailable",
          sessionId: null,
        }),
        202,
      );
    }
    const binding = await getLensRepositoryBindingForProviderEvent(db, {
      accountId,
      workspaceId,
      registrationId,
      providerRepositoryId: normalized.providerRepositoryId,
    });
    if (!binding || binding.status !== "active") {
      return c.json(
        LensWebhookResult.parse({
          accepted: false,
          duplicate: false,
          ignoredReason: "repository_not_enabled",
          sessionId: null,
        }),
        202,
      );
    }
    const providerAuthorityMismatch =
      (binding.installationId !== null && normalized.installationId !== binding.installationId) ||
      (binding.projectId !== null && normalized.projectId !== binding.projectId)
        ? "provider_authority_mismatch"
        : null;
    const requestDigest = createHash("sha256")
      .update(registration.provider)
      .update("\0")
      .update(eventName)
      .update("\0")
      .update(body)
      .digest("hex");
    const deliveryKey = lensDeliveryKey(registration.provider, c.req.raw.headers, requestDigest);
    let recorded: Awaited<ReturnType<typeof recordLensWebhookDelivery>>;
    try {
      recorded = await recordLensWebhookDelivery(db, {
        accountId,
        workspaceId,
        registrationId,
        repositoryBindingId: binding.id,
        provider: registration.provider,
        deliveryKey,
        requestDigest,
        eventName: normalized.eventName,
        action: normalized.action,
        pullRequestId: normalized.pullRequestId,
        headSha: normalized.headSha,
        baseSha: normalized.baseSha,
        ignoredReason: normalized.ignoredReason ?? providerAuthorityMismatch,
      });
    } catch (error) {
      if (error instanceof LensDeliveryConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
    if (recorded.delivery.status === "ignored") {
      return c.json(
        LensWebhookResult.parse({
          accepted: false,
          duplicate: recorded.duplicate,
          ignoredReason: recorded.delivery.ignoredReason,
          sessionId: null,
        }),
        202,
      );
    }
    if (recorded.delivery.status === "dispatched" && recorded.delivery.sessionId) {
      return c.json(
        LensWebhookResult.parse({
          accepted: true,
          duplicate: true,
          ignoredReason: null,
          sessionId: recorded.delivery.sessionId,
        }),
      );
    }
    if (!normalized.pullRequestId || !normalized.headSha) {
      throw new HTTPException(422, {
        message: "Lens webhook lacks an immutable pull-request head",
      });
    }
    try {
      const session = await dispatchLensReviewSession(deps, {
        accountId,
        workspaceId,
        registration,
        binding,
        deliveryId: recorded.delivery.id,
        event: {
          ...normalized,
          pullRequestId: normalized.pullRequestId,
          headSha: normalized.headSha,
        },
      });
      await completeLensWebhookDelivery(db, {
        accountId,
        workspaceId,
        deliveryId: recorded.delivery.id,
        sessionId: session.id,
      });
      return c.json(
        LensWebhookResult.parse({
          accepted: true,
          duplicate: recorded.duplicate,
          ignoredReason: null,
          sessionId: session.id,
        }),
        202,
      );
    } catch (error) {
      await failLensWebhookDelivery(db, {
        accountId,
        workspaceId,
        deliveryId: recorded.delivery.id,
        errorCode: lensDispatchErrorCode(error),
      }).catch(() => undefined);
      throw new HTTPException(503, {
        message: "Lens review dispatch failed; the provider may retry this delivery",
        cause: error,
      });
    }
  });
}

async function dispatchLensReviewSession(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    registration: LensAppRegistration;
    binding: LensRepositoryBinding;
    deliveryId: string;
    event: ReturnType<typeof normalizeLensPullRequestEvent> & {
      pullRequestId: string;
      headSha: string;
    };
  },
) {
  assertLensSandboxBackend(deps);
  const model =
    canonicalConfiguredModel(deps.settings, input.binding.model ?? deps.settings.openaiModel) ??
    null;
  if (!model) throw new Error("OpenGeni Lens has no configured model");
  await assertWorkspaceModelPolicyAllows(deps.db, deps.settings, input.workspaceId, model);
  await requireLimit(deps, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    action: "agent_run:create",
    quantity: 1,
    model,
  });
  const reasoningEffort = deps.settings.openaiReasoningEffort;
  const turnExecutionPolicy = resolveTurnExecutionPolicyV1(deps.settings, {
    modelId: model,
    requestedModelId: input.binding.model,
    modelSource: input.binding.model ? "explicit" : "deployment",
    reasoningEffort,
    reasoningSource: "deployment",
    latencyMode: "standard",
    latencyModeSource: "deployment",
  });
  const installationId = positiveInteger(input.binding.installationId);
  const repositoryId = positiveInteger(input.binding.providerRepositoryId);
  const created = await createAndStartSessionWithOutcome({
    requestedSessionId: input.deliveryId,
    db: deps.db,
    bus: deps.bus,
    workflowClient: deps.workflowClient,
    beforeCreateCommit: async (tx) => {
      await assertLensDispatchAuthorityInTransaction(tx, {
        workspaceId: input.workspaceId,
        registrationId: input.registration.id,
        repositoryBindingId: input.binding.id,
        providerRepositoryId: input.binding.providerRepositoryId,
      });
    },
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: lensReviewPrompt({
      provider: input.registration.provider,
      providerBaseUrl: input.registration.providerBaseUrl,
      repositoryFullName: input.binding.repositoryFullName,
      providerRepositoryId: input.binding.providerRepositoryId,
      projectId: input.binding.projectId,
      pullRequestId: input.event.pullRequestId,
      headSha: input.event.headSha,
      baseSha: input.event.baseSha,
      headRef: input.event.headRef,
      baseRef: input.event.baseRef,
    }),
    resources: [
      {
        kind: "repository",
        uri: input.binding.repositoryUri,
        ref: input.event.headSha,
        expectedCommitSha: input.event.headSha,
        provider: input.registration.provider,
        credentialBindingId: lensCredentialBindingId(input.registration.id),
        access: "write",
        repositoryId: input.binding.providerRepositoryId,
        ...(input.binding.installationId ? { installationId: input.binding.installationId } : {}),
        ...(input.binding.projectId ? { projectId: input.binding.projectId } : {}),
        ...(input.registration.provider === "github" && installationId && repositoryId
          ? {
              githubInstallationId: installationId,
              githubRepositoryId: repositoryId,
            }
          : {}),
      },
    ],
    skills: [OPENGENI_LENS_SKILL],
    tools: [],
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    model,
    reasoningEffort,
    turnExecutionPolicy,
    sandboxBackend: deps.settings.sandboxBackend,
    metadata: lensSessionMetadata({
      provider: input.registration.provider,
      registrationId: input.registration.id,
      repositoryBindingId: input.binding.id,
      providerRepositoryId: input.binding.providerRepositoryId,
      pullRequestId: input.event.pullRequestId,
      headSha: input.event.headSha,
      deliveryId: input.deliveryId,
    }),
    createdBy: {
      kind: "service",
      subjectId: "opengeni-lens",
      label: "OpenGeni Lens",
    },
    createdByContext: {
      provider: input.registration.provider,
      deliveryId: input.deliveryId,
      repositoryBindingId: input.binding.id,
      pullRequestId: input.event.pullRequestId,
      headSha: input.event.headSha,
    },
    instructions: [
      OPENGENI_LENS_AGENT_INSTRUCTIONS,
      input.binding.additionalInstructions?.trim() || null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
    policyRole: "pull_request_review",
    firstPartyMcpPermissions: [],
    firstPartyMcpTools: [],
    createIdempotencyKey: `lens:${input.binding.id}:pr:${input.event.pullRequestId}:head:${input.event.headSha}`,
    subjectId: "opengeni-lens",
  });
  try {
    await recordWorkspaceUsage(
      { db: deps.db, settings: deps.settings },
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: "opengeni-lens",
        eventType: "agent_run.created",
        quantity: 1,
        unit: "run",
        sourceResourceType: "lens_repository_binding",
        sourceResourceId: input.binding.id,
        sessionId: created.session.id,
        initiator: created.session.createdBy,
        initiatorContext: created.session.createdByContext,
        origin: "system",
        idempotencyKey: `agent_run.created:lens:${input.binding.id}:${input.event.pullRequestId}:${input.event.headSha}`,
      },
    );
  } catch {
    // The session commit is authoritative; usage has its own deterministic
    // idempotency key and follows the same non-fatal behavior as API creation.
  }
  return created.session;
}

function assertLensSandboxBackend(deps: ApiRouteDeps): void {
  if (deps.settings.sandboxBackend === "selfhosted") {
    throw new HTTPException(409, {
      message:
        "OpenGeni Lens requires managed compute so it can materialize and verify the exact pull-request head",
    });
  }
}

async function requireLensPackActive(db: ApiRouteDeps["db"], workspaceId: string): Promise<void> {
  const installation = await getPackInstallation(db, workspaceId, OPENGENI_LENS_PACK_ID);
  if (installation?.status !== "active") {
    throw new HTTPException(409, {
      message: "Install and enable the OpenGeni Lens Pack first",
    });
  }
}

function requireLensEncryptionKey(deps: ApiRouteDeps): Uint8Array {
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) {
    throw new HTTPException(503, {
      message: "OpenGeni Lens requires configured secret encryption",
    });
  }
  return key;
}

async function mapLensUniqueConflict<T>(operation: Promise<T>, message: string): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (nestedPostgresSqlState(error) === "23505") {
      throw new HTTPException(409, { message });
    }
    throw error;
  }
}

function lensEventName(provider: LensProvider, headers: Headers, payload: unknown): string {
  if (provider === "github") return boundedLensEventName(headers.get("x-github-event"));
  if (provider === "gitlab") return boundedLensEventName(headers.get("x-gitlab-event"));
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>).eventType;
    if (typeof value === "string") return boundedLensEventName(value);
  }
  return "unknown";
}

function boundedLensEventName(value: string | null): string {
  const normalized = value?.trim();
  return normalized && normalized.length <= 200 ? normalized : "unknown";
}

function lensDeliveryKey(provider: LensProvider, headers: Headers, requestDigest: string): string {
  const providerKey =
    provider === "github"
      ? headers.get("x-github-delivery")
      : provider === "gitlab"
        ? (headers.get("x-gitlab-event-uuid") ?? headers.get("idempotency-key"))
        : (headers.get("x-vss-e2eid") ?? headers.get("x-vss-activityid"));
  const raw = providerKey?.trim() || `body:${requestDigest}`;
  return raw.length <= 512 ? raw : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function lensDispatchErrorCode(error: unknown): string {
  if (error instanceof LensDispatchAuthorityError) return "authority_changed";
  if (error instanceof HTTPException) return `http_${error.status}`;
  return "dispatch_failed";
}

export async function readLensWebhookBody(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > LENS_WEBHOOK_MAX_BYTES) {
    throw new HTTPException(413, {
      message: "Lens webhook payload is too large",
    });
  }
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LENS_WEBHOOK_MAX_BYTES) {
        await reader.cancel();
        throw new HTTPException(413, {
          message: "Lens webhook payload is too large",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
