import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  CreatePrReviewAppRegistrationRequest,
  CreatePrReviewRepositoryBindingRequest,
  PrReviewAppRegistration,
  PrReviewRepositoryBinding,
  OPENGENI_PR_REVIEW_PACK_ID,
  UpdatePrReviewAppRegistrationRequest,
  UpdatePrReviewRepositoryBindingRequest,
} from "@opengeni/contracts";
import {
  assertWorkspaceModelPolicyAllows,
  canonicalConfiguredModel,
  defaultPrReviewProviderBaseUrl,
  getCapabilityPack,
  prReviewWebhookAuthKind,
  normalizePrReviewProviderBaseUrl,
  PR_REVIEW_AUTOMATION_TEMPLATE_ID,
  requireAccessGrant,
  requirePermission,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createPrReviewAppRegistration,
  createPrReviewRepositoryBinding,
  deletePrReviewAppRegistration,
  deletePrReviewRepositoryBinding,
  decryptVariableSetValue,
  encryptVariableSetValue,
  getPrReviewAppRegistrationSecret,
  getPackInstallation,
  listPrReviewAppRegistrations,
  listPrReviewRepositoryBindings,
  nestedPostgresSqlState,
  recordAuditEvent,
  updatePrReviewAppRegistration,
  updatePrReviewRepositoryBinding,
} from "@opengeni/db";
import { listGitHubAppRepositoriesWithSigningSettings } from "@opengeni/github";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  PrReviewProviderRepositoryError,
  verifyPrReviewProviderRepository,
} from "../integrations/pr-review-provider";

export function registerPrReviewRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;

  app.get("/v1/workspaces/:workspaceId/pr-review/registrations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await requirePrReviewPackActive(db, workspaceId);
    return c.json({
      registrations: await listPrReviewAppRegistrations(db, grant.accountId, workspaceId),
      repositories: await listPrReviewRepositoryBindings(db, grant.accountId, workspaceId),
    });
  });

  app.post("/v1/workspaces/:workspaceId/pr-review/registrations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    requirePermission(grant, "secrets:write");
    await requirePrReviewPackActive(db, workspaceId);
    assertPrReviewSandboxBackend(deps);
    const payload = CreatePrReviewAppRegistrationRequest.parse(await c.req.json());
    const encryptionKey = requirePrReviewEncryptionKey(deps);
    let providerBaseUrl: string;
    try {
      providerBaseUrl = normalizePrReviewProviderBaseUrl(
        payload.provider,
        payload.providerBaseUrl ?? defaultPrReviewProviderBaseUrl(payload.provider),
      );
    } catch (error) {
      throw new HTTPException(422, {
        message:
          error instanceof Error
            ? error.message
            : "PR Review providerBaseUrl must be a credential-free HTTPS origin or path",
      });
    }
    if (
      payload.provider === "azure_devops" &&
      new URL(providerBaseUrl).pathname.split("/").filter(Boolean).length === 0
    ) {
      throw new HTTPException(422, {
        message: "Azure DevOps PR Review providerBaseUrl must include the organization path",
      });
    }
    const registration = await mapPrReviewUniqueConflict(
      createPrReviewAppRegistration(db, {
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
        webhookAuthKind: prReviewWebhookAuthKind(payload.provider),
        webhookSecretEncrypted: encryptVariableSetValue(encryptionKey, payload.webhookSecret),
        webhookUsername: payload.webhookUsername ?? null,
        createdBySubjectId: grant.subjectId,
      }),
      "A PR Review registration with this provider and name already exists",
    );
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.app_registration.created",
      targetType: "pr_review_app_registration",
      targetId: registration.id,
      metadata: {
        provider: registration.provider,
        credentialKind: registration.credentialKind,
        webhookAuthKind: registration.webhookAuthKind,
      },
    });
    return c.json(PrReviewAppRegistration.parse(registration), 201);
  });

  app.patch("/v1/workspaces/:workspaceId/pr-review/registrations/:registrationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    requirePermission(grant, "secrets:write");
    await requirePrReviewPackActive(db, workspaceId);
    const payload = UpdatePrReviewAppRegistrationRequest.parse(await c.req.json());
    const existing = await getPrReviewAppRegistrationSecret(db, {
      accountId: grant.accountId,
      workspaceId,
      registrationId: c.req.param("registrationId"),
    });
    if (!existing)
      throw new HTTPException(404, {
        message: "PR Review app registration not found",
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
        ? requirePrReviewEncryptionKey(deps)
        : null;
    const updated = await mapPrReviewUniqueConflict(
      updatePrReviewAppRegistration(db, {
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
      "A PR Review registration with this provider and name already exists",
    );
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.app_registration.updated",
      targetType: "pr_review_app_registration",
      targetId: existing.id,
      metadata: {
        fields: Object.keys(payload).filter(
          (field) => field !== "accessToken" && field !== "privateKey" && field !== "webhookSecret",
        ),
        credentialRotated: payload.accessToken !== undefined || payload.privateKey !== undefined,
        webhookSecretRotated: payload.webhookSecret !== undefined,
      },
    });
    return c.json(PrReviewAppRegistration.parse(updated));
  });

  app.delete("/v1/workspaces/:workspaceId/pr-review/registrations/:registrationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const deleted = await deletePrReviewAppRegistration(db, {
      accountId: grant.accountId,
      workspaceId,
      registrationId: c.req.param("registrationId"),
    });
    if (!deleted)
      throw new HTTPException(404, {
        message: "PR Review app registration not found",
      });
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.app_registration.disabled",
      targetType: "pr_review_app_registration",
      targetId: c.req.param("registrationId"),
      metadata: {},
    });
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/pr-review/repositories", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const packInstallation = await requirePrReviewPackActive(db, workspaceId);
    const payload = CreatePrReviewRepositoryBindingRequest.parse(await c.req.json());
    const registration = await getPrReviewAppRegistrationSecret(db, {
      accountId: grant.accountId,
      workspaceId,
      registrationId: payload.registrationId,
    });
    if (!registration)
      throw new HTTPException(404, {
        message: "PR Review app registration not found",
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
      const encryptionKey = requirePrReviewEncryptionKey(deps);
      if (!registration.credentialEncrypted) {
        throw new HTTPException(409, {
          message: "PR Review GitHub App credential is unavailable",
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
          message: "GitHub repository is not installed for this PR Review App",
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
          message: "PR Review provider credential has expired",
        });
      }
      const encryptionKey = requirePrReviewEncryptionKey(deps);
      if (!registration.credentialEncrypted) {
        throw new HTTPException(409, {
          message: "PR Review provider credential is unavailable",
        });
      }
      try {
        const verified = await verifyPrReviewProviderRepository({
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
        if (error instanceof PrReviewProviderRepositoryError) {
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
    const template = getCapabilityPack(OPENGENI_PR_REVIEW_PACK_ID)?.automationTemplates?.find(
      (candidate) => candidate.id === PR_REVIEW_AUTOMATION_TEMPLATE_ID,
    );
    if (!template) {
      throw new HTTPException(503, { message: "PR Review automation template is unavailable" });
    }
    const binding = await mapPrReviewUniqueConflict(
      createPrReviewRepositoryBinding(db, {
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
        packInstallationId: packInstallation.id,
        packTemplateId: template.id,
        adapterId: template.adapterId,
        eventTypes: template.eventTypes,
        configuration: template.configuration,
        sessionTemplate: template.sessionTemplate,
      }),
      "This repository is already bound to the selected PR Review registration",
    );
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.repository_binding.created",
      targetType: "pr_review_repository_binding",
      targetId: binding.id,
      metadata: {
        provider: binding.provider,
        registrationId: binding.registrationId,
        providerRepositoryId: binding.providerRepositoryId,
      },
    });
    return c.json(PrReviewRepositoryBinding.parse(binding), 201);
  });

  app.patch("/v1/workspaces/:workspaceId/pr-review/repositories/:bindingId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    await requirePrReviewPackActive(db, workspaceId);
    const payload = UpdatePrReviewRepositoryBindingRequest.parse(await c.req.json());
    const model =
      payload.model === undefined
        ? undefined
        : payload.model === null
          ? null
          : (canonicalConfiguredModel(settings, payload.model) ?? null);
    if (model) await assertWorkspaceModelPolicyAllows(db, settings, workspaceId, model);
    const binding = await updatePrReviewRepositoryBinding(db, {
      accountId: grant.accountId,
      workspaceId,
      bindingId: c.req.param("bindingId"),
      subjectId: grant.subjectId,
      ...(model !== undefined ? { model } : {}),
      ...(payload.additionalInstructions !== undefined
        ? { additionalInstructions: payload.additionalInstructions }
        : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
    });
    if (!binding)
      throw new HTTPException(404, {
        message: "PR Review repository binding not found",
      });
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.repository_binding.updated",
      targetType: "pr_review_repository_binding",
      targetId: binding.id,
      metadata: { fields: Object.keys(payload) },
    });
    return c.json(PrReviewRepositoryBinding.parse(binding));
  });

  app.delete("/v1/workspaces/:workspaceId/pr-review/repositories/:bindingId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const deleted = await deletePrReviewRepositoryBinding(db, {
      accountId: grant.accountId,
      workspaceId,
      bindingId: c.req.param("bindingId"),
      subjectId: grant.subjectId,
    });
    if (!deleted)
      throw new HTTPException(404, {
        message: "PR Review repository binding not found",
      });
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.repository_binding.disabled",
      targetType: "pr_review_repository_binding",
      targetId: c.req.param("bindingId"),
      metadata: {},
    });
    return c.body(null, 204);
  });
}

function assertPrReviewSandboxBackend(deps: ApiRouteDeps): void {
  if (deps.settings.sandboxBackend === "selfhosted") {
    throw new HTTPException(409, {
      message:
        "OpenGeni Review Bot requires managed compute so it can materialize and verify the exact pull-request head",
    });
  }
}

async function requirePrReviewPackActive(db: ApiRouteDeps["db"], workspaceId: string) {
  const installation = await getPackInstallation(db, workspaceId, OPENGENI_PR_REVIEW_PACK_ID);
  if (installation?.status !== "active") {
    throw new HTTPException(409, {
      message: "Install and enable the OpenGeni Review Bot Pack first",
    });
  }
  return installation;
}

function requirePrReviewEncryptionKey(deps: ApiRouteDeps): Uint8Array {
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) {
    throw new HTTPException(503, {
      message: "OpenGeni Review Bot requires configured secret encryption",
    });
  }
  return key;
}

async function mapPrReviewUniqueConflict<T>(operation: Promise<T>, message: string): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (nestedPostgresSqlState(error) === "23505") {
      throw new HTTPException(409, { message });
    }
    throw error;
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
