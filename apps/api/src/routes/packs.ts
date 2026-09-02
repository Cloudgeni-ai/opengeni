import { createHash } from "node:crypto";

import {
  EnablePackRequest,
  InstallPackRequest,
  MarketingDailyAnalysisTaskRequest,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
  PreviewPackInstallationRequest,
  RegisterCapabilityPackRequest,
  UninstallPackRequest,
  UninstallPackResult,
  stableJson,
  type SocialConnection,
} from "@opengeni/contracts";
import {
  adoptPackComponentReferences,
  CapabilityComponentVersionConflictError,
  deferPackInstallationOperation,
  deleteWorkspacePack,
  disableCapabilityInstallation,
  enablePackInstallation,
  finalizePackComponentOwnership,
  finalizePackInstallationOperation,
  finalizePackUninstallOperation,
  getCapabilityInstallation,
  getPackInstallation,
  getWorkspacePack,
  getSocialConnection,
  installPortableSkill,
  listPackInstallations,
  listSocialConnections,
  PackManifestChangedError,
  PackComponentResolutionError,
  PackInstallationVersionConflictError,
  PackInstallationVersionRequiredError,
  PackOperationClaimLostError,
  PackOperationIdempotencyError,
  PackOperationInProgressError,
  preparePackInstallationOperation,
  preparePackUninstallOperation,
  previewPackComponentRelease,
  recordPackInlineSkillComponent,
  registerWorkspacePack,
  releasePackComponents,
  touchPackInstallationOperation,
  updatePackInstallationStatus,
} from "@opengeni/db";
import { getDocumentBase } from "@opengeni/documents";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import { requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { validateVariableSetAttachment } from "@opengeni/core";
import {
  assertPackSandboxImageCompatible,
  buildMarketingDailyAnalysisAgentConfig,
  capabilityPackRequiresInstallationPlan,
  inlinePackSkillInstall,
  isBuiltInCapabilityPack,
  listWorkspaceCapabilityPacks,
  MARKETING_SOCIAL_PACK_ID,
  previewCapabilityPackInstallation,
  resolveCapabilityPack,
} from "@opengeni/core";
import { createValidatedScheduledTask, syncCreatedScheduledTask } from "@opengeni/core";

export function registerPackRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db, objectStorage, workflowClient } = deps;

  app.get("/v1/workspaces/:workspaceId/packs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json({
      packs: await listWorkspaceCapabilityPacks(db, workspaceId),
      installations: await listPackInstallations(db, workspaceId),
    });
  });

  // Registers (or replaces) a workspace-scoped pack from a manifest payload.
  // Built-in pack ids stay reserved so a registration can never shadow them.
  app.post("/v1/workspaces/:workspaceId/packs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const manifest = RegisterCapabilityPackRequest.parse(await c.req.json());
    if (isBuiltInCapabilityPack(manifest.id)) {
      throw new HTTPException(409, {
        message: `pack id ${manifest.id} is a built-in pack and cannot be replaced`,
      });
    }
    const { pack, created } = await registerWorkspacePack(db, {
      accountId: grant.accountId,
      workspaceId,
      pack: manifest,
    });
    return c.json(pack, created ? 201 : 200);
  });

  app.delete("/v1/workspaces/:workspaceId/packs/:packId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const packId = c.req.param("packId");
    if (isBuiltInCapabilityPack(packId)) {
      throw new HTTPException(409, {
        message: "built-in packs cannot be unregistered",
      });
    }
    if (!(await getWorkspacePack(db, workspaceId, packId))) {
      throw new HTTPException(404, { message: "pack not found" });
    }
    // V2 Packs own explicit components. Unregistering before the ownership
    // ledger is safely released would orphan those components, so require the
    // dedicated uninstall flow first. Legacy installations retain the old
    // disable-before-delete behavior for compatibility.
    const installation = await getPackInstallation(db, workspaceId, packId);
    if (
      installation &&
      installation.status !== "disabled" &&
      (installation.manifestDigest !== null || installation.manifestSnapshot !== null)
    ) {
      throw new HTTPException(409, {
        message: "uninstall this Pack before unregistering it",
      });
    }
    if (installation && installation.status === "active") {
      await updatePackInstallationStatus(db, workspaceId, packId, "disabled");
    }
    const capabilityInstallation = await getCapabilityInstallation(
      db,
      workspaceId,
      `pack:${packId}`,
    );
    if (capabilityInstallation && capabilityInstallation.status === "active") {
      await disableCapabilityInstallation(db, workspaceId, `pack:${packId}`);
    }
    await deleteWorkspacePack(db, workspaceId, packId);
    return c.body(null, 204);
  });

  app.get("/v1/workspaces/:workspaceId/packs/installations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(await listPackInstallations(db, workspaceId));
  });

  app.get("/v1/workspaces/:workspaceId/packs/:packId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
    return c.json({
      pack,
      installation: await getPackInstallation(db, workspaceId, pack.id),
    });
  });

  app.post("/v1/workspaces/:workspaceId/packs/:packId/installation-preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
    const payload = PreviewPackInstallationRequest.parse(await c.req.json());
    return c.json(
      PackInstallationPreview.parse(
        await previewCapabilityPackInstallation(db, grant, pack, {
          ...(payload.rigId ? { rigId: payload.rigId } : {}),
          ...(payload.variableSetId ? { variableSetId: payload.variableSetId } : {}),
        }),
      ),
    );
  });

  app.post("/v1/workspaces/:workspaceId/packs/:packId/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
    const payload = InstallPackRequest.parse(await c.req.json());
    const preview = PackInstallationPreview.parse(
      await previewCapabilityPackInstallation(db, grant, pack, {
        ...(payload.rigId ? { rigId: payload.rigId } : {}),
        ...(payload.variableSetId ? { variableSetId: payload.variableSetId } : {}),
      }),
    );
    if (preview.manifestDigest !== payload.expectedManifestDigest) {
      throw new HTTPException(409, {
        message: "The Pack manifest changed after preview. Review the updated installation plan.",
      });
    }
    if (!preview.ready) {
      throw new HTTPException(422, {
        message: `The Pack is not ready to install: ${preview.blockers.join("; ")}`,
      });
    }
    if (preview.variableSetId) {
      await validateVariableSetAttachment(
        { settings, db },
        grant,
        workspaceId,
        preview.variableSetId,
        { preauthorized: payload.variableSetId === undefined },
      );
    }
    const metadata = {
      ...payload.metadata,
      platformVersion: 2,
      packVersion: pack.version,
      ...(preview.variableSetId ? { variableSetId: preview.variableSetId } : {}),
    };
    const requestDigest = sha256(
      stableJson({
        packId: pack.id,
        manifestDigest: preview.manifestDigest,
        expectedInstallationVersion: payload.expectedInstallationVersion ?? null,
        selectedRigId: preview.rig.rigId,
        variableSetId: preview.variableSetId,
        metadata,
      }),
    );
    let prepared: Awaited<ReturnType<typeof preparePackInstallationOperation>>;
    try {
      prepared = await preparePackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        pack,
        manifestDigest: preview.manifestDigest,
        selectedRigId: preview.rig.rigId,
        metadata,
        idempotencyKey: payload.idempotencyKey,
        requestDigest,
        ...(!isBuiltInCapabilityPack(pack.id)
          ? { registeredManifestDigest: preview.manifestDigest }
          : {}),
        ...(payload.expectedInstallationVersion !== undefined
          ? { expectedInstallationVersion: payload.expectedInstallationVersion }
          : {}),
      });
    } catch (error) {
      throw packMutationHttpError(error);
    }
    if (prepared.replayResult) {
      const replayed = await getPackInstallation(db, workspaceId, pack.id);
      if (!replayed) {
        throw new HTTPException(500, {
          message: "The completed Pack operation lost its installation record",
        });
      }
      return c.json(PackInstallation.parse(replayed), 200);
    }

    const retainedComponentKeys: string[] = [];
    const retainedFacetInstallationIds: string[] = [];
    const retainedBindingIds: string[] = [];
    let activeComponentKey = "manifest";
    const heartbeat = async (): Promise<void> =>
      await touchPackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
      });
    try {
      for (const skill of pack.skills) {
        await heartbeat();
        const inline = inlinePackSkillInstall(pack, skill);
        activeComponentKey = inline.componentKey;
        const installed = await installPortableSkill(db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          capabilityId: inline.capabilityId,
          pluginKey: inline.pluginKey,
          source: "pack",
          sourceUrl: inline.sourceUrl,
          repositoryUrl: inline.repositoryUrl,
          sourceCommit: inline.sourceCommit,
          sourcePath: inline.sourcePath,
          name: inline.name,
          description: inline.description,
          activationMode: inline.activationMode,
          contentSha256: inline.contentSha256,
          totalBytes: inline.totalBytes,
          files: inline.files,
          owner: {
            kind: "pack",
            id: prepared.installation.id,
            removable: true,
          },
        });
        await heartbeat();
        await recordPackInlineSkillComponent(db, {
          accountId: grant.accountId,
          workspaceId,
          packInstallationId: prepared.installation.id,
          componentKey: inline.componentKey,
          capabilityId: inline.capabilityId,
          facetInstallationId: installed.facetInstallationId,
          contentSha256: inline.contentSha256,
          name: inline.name,
        });
        retainedComponentKeys.push(inline.componentKey);
        retainedFacetInstallationIds.push(installed.facetInstallationId);
      }

      activeComponentKey = "pinned-components";
      await heartbeat();
      const adopted = await adoptPackComponentReferences(db, {
        accountId: grant.accountId,
        workspaceId,
        packInstallationId: prepared.installation.id,
        references: pack.components,
      });
      retainedComponentKeys.push(...adopted.components.map((component) => component.key));
      retainedFacetInstallationIds.push(...adopted.retainedFacetInstallationIds);
      retainedBindingIds.push(...adopted.retainedBindingIds);

      activeComponentKey = "ownership-finalize";
      await heartbeat();
      await finalizePackComponentOwnership(db, {
        accountId: grant.accountId,
        workspaceId,
        packInstallationId: prepared.installation.id,
        retainedComponentKeys,
        retainedFacetInstallationIds,
        retainedBindingIds,
      });
      await heartbeat();
      const finalized = await finalizePackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
        packInstallationId: prepared.installation.id,
        packId: pack.id,
        result: {
          status: "installed",
          packId: pack.id,
          manifestDigest: preview.manifestDigest,
          componentCount: retainedComponentKeys.length,
        },
      });
      return c.json(
        PackInstallation.parse(finalized),
        preview.installationVersion === null ? 201 : 200,
      );
    } catch (error) {
      await deferPackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
        packInstallationId: prepared.installation.id,
        phase: `component_failed:${activeComponentKey}`,
        errorCode: packFailureCode(error),
      }).catch(() => undefined);
      if (error instanceof PackComponentResolutionError) {
        throw new HTTPException(409, {
          message: `Pack component ${error.componentKey} changed after preview. Review the installation plan and retry with the same idempotency key.`,
        });
      }
      if (error instanceof CapabilityComponentVersionConflictError) {
        throw new HTTPException(409, {
          message: `Pack component ${activeComponentKey} is pinned by another installed owner. Resolve that version conflict and retry with the same idempotency key.`,
        });
      }
      if (error instanceof PackOperationClaimLostError) {
        throw packMutationHttpError(error);
      }
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(422, {
        message: `Pack component ${activeComponentKey} could not be installed. No Pack-owned component is active until the operation completes; retry with the same idempotency key.`,
      });
    }
  });

  app.get("/v1/workspaces/:workspaceId/packs/:packId/uninstall-preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
    const installation = await getPackInstallation(db, workspaceId, pack.id);
    const installed = Boolean(installation && installation.status !== "disabled");
    const components = installed
      ? await previewPackComponentRelease(db, workspaceId, installation!.id)
      : [];
    return c.json(
      PackUninstallPreview.parse({
        packId: pack.id,
        installed,
        installationVersion: installation?.version ?? null,
        components,
      }),
    );
  });

  app.delete("/v1/workspaces/:workspaceId/packs/:packId/installation", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
    const payload = UninstallPackRequest.parse(await c.req.json());
    const requestDigest = sha256(
      stableJson({
        packId: pack.id,
        expectedInstallationVersion: payload.expectedInstallationVersion,
      }),
    );
    let prepared: Awaited<ReturnType<typeof preparePackUninstallOperation>>;
    try {
      prepared = await preparePackUninstallOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        packId: pack.id,
        expectedInstallationVersion: payload.expectedInstallationVersion,
        idempotencyKey: payload.idempotencyKey,
        requestDigest,
      });
    } catch (error) {
      throw packMutationHttpError(error);
    }
    if (!("installation" in prepared)) {
      return c.json(
        UninstallPackResult.parse({
          packId: pack.id,
          status:
            prepared.replayResult.status === "not_installed" ? "not_installed" : "uninstalled",
          retainedComponents: Array.isArray(prepared.replayResult.retainedComponents)
            ? prepared.replayResult.retainedComponents
            : [],
        }),
      );
    }
    try {
      await touchPackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
      });
      const released = await releasePackComponents(db, {
        accountId: grant.accountId,
        workspaceId,
        packInstallationId: prepared.installation.id,
      });
      await touchPackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
      });
      const result = UninstallPackResult.parse({
        packId: pack.id,
        status: "uninstalled",
        retainedComponents: [...new Set(released.retainedComponents)],
      });
      await finalizePackUninstallOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
        packInstallationId: prepared.installation.id,
        packId: pack.id,
        result,
      });
      return c.json(result);
    } catch (error) {
      await deferPackInstallationOperation(db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
        packInstallationId: prepared.installation.id,
        phase: "uninstall_failed",
        errorCode: packFailureCode(error),
      }).catch(() => undefined);
      if (error instanceof PackOperationClaimLostError) {
        throw packMutationHttpError(error);
      }
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(422, {
        message: "The Pack could not be safely uninstalled. Retry with the same idempotency key.",
      });
    }
  });

  app.post("/v1/workspaces/:workspaceId/packs/:packId/enable", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
    if (capabilityPackRequiresInstallationPlan(pack)) {
      throw new HTTPException(409, {
        message:
          "This Pack uses component or Rig requirements. Preview and install it through the Pack installation flow.",
      });
    }
    await assertPackSandboxImageCompatible(db, workspaceId, pack);
    const existing = await getPackInstallation(db, workspaceId, pack.id);
    const payload = EnablePackRequest.parse(await c.req.json());
    // Re-enabling without variableSetId keeps the stored attachment instead of
    // silently dropping it; the inherited attachment is re-validated below in
    // case the variableSet was deleted or its variables changed since. The
    // inherited attachment was authorized with variableSets:use when it was
    // first attached, so only a fresh attachment re-checks that permission.
    // Back-compat: installations enabled before the Variable Set rename stored
    // the attachment under `metadata.environmentId`; read it as a fallback so a
    // re-enable without an explicit id still inherits the existing attachment.
    const storedVariableSetId =
      typeof existing?.metadata.variableSetId === "string"
        ? existing.metadata.variableSetId
        : typeof existing?.metadata.environmentId === "string"
          ? existing.metadata.environmentId
          : undefined;
    const variableSetId = payload.variableSetId ?? storedVariableSetId;
    if (pack.variableSet?.required && !variableSetId) {
      throw new HTTPException(422, {
        message: "this pack requires a variableSet attachment; pass variableSetId",
      });
    }
    if (variableSetId) {
      const variableSet = await validateVariableSetAttachment(
        { settings, db },
        grant,
        workspaceId,
        variableSetId,
        { preauthorized: !payload.variableSetId },
      );
      const missing = (pack.variableSet?.requiredVariables ?? []).filter(
        (name) => !variableSet.variables.some((variable) => variable.name === name),
      );
      if (missing.length > 0) {
        throw new HTTPException(422, {
          message: `variableSet is missing required variable(s): ${missing.join(", ")}`,
        });
      }
    }
    const installation = await enablePackInstallation(db, {
      accountId: grant.accountId,
      workspaceId,
      packId: pack.id,
      metadata: {
        ...payload.metadata,
        packVersion: pack.version,
        ...(variableSetId ? { variableSetId } : {}),
      },
    });
    return c.json(installation, existing ? 200 : 201);
  });

  app.post(
    "/v1/workspaces/:workspaceId/packs/marketing-social-daily-analysis/scheduled-tasks",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
      const pack = await requirePack(db, workspaceId, MARKETING_SOCIAL_PACK_ID);
      const installation = await getPackInstallation(db, workspaceId, pack.id);
      if (installation?.status !== "active") {
        throw new HTTPException(409, {
          message: "enable the marketing social pack before creating its scheduled tasks",
        });
      }
      const payload = MarketingDailyAnalysisTaskRequest.parse(await c.req.json());
      await requireLimit(deps, {
        accountId: grant.accountId,
        workspaceId,
        action: "schedule:create",
        quantity: 1,
      });
      const connections = await resolveSocialConnections(
        db,
        workspaceId,
        payload.connectionIds,
        grant.subjectId,
      );
      if (connections.length === 0) {
        throw new HTTPException(422, {
          message: "at least one connected social account is required",
        });
      }
      await validateDocumentBaseIds(db, workspaceId, payload.documentBaseIds);
      const agentConfig = buildMarketingDailyAnalysisAgentConfig({
        connections,
        documentBaseIds: payload.documentBaseIds,
        ...(payload.promptInstructions ? { promptInstructions: payload.promptInstructions } : {}),
      });
      // Installation-inherited variableSet attachment: it was authorized with
      // variableSets:use at pack-enable time, so the scheduled_tasks:manage
      // caller here is not re-checked for that permission.
      const installationVariableSetId =
        typeof installation.metadata.variableSetId === "string"
          ? installation.metadata.variableSetId
          : typeof installation.metadata.environmentId === "string"
            ? installation.metadata.environmentId
            : undefined;
      const task = await createValidatedScheduledTask({
        settings,
        db,
        objectStorage,
        grant,
        variableSetPreauthorized: true,
        payload: {
          name: payload.name ?? "Daily social media analysis",
          status: payload.status,
          action: { kind: "agent_turn" },
          connectionAuthorities: [],
          schedule: {
            type: "calendar",
            timeZone: payload.timeZone,
            hour: payload.hour,
            minute: payload.minute,
          },
          runMode: payload.runMode,
          overlapPolicy: payload.overlapPolicy,
          agentConfig,
          ...(installationVariableSetId ? { variableSetId: installationVariableSetId } : {}),
          ...(installation.selectedRigId ? { rigId: installation.selectedRigId } : {}),
          metadata: {
            packId: pack.id,
            packVersion: pack.version,
            packTemplateId: "daily-social-analysis",
            socialConnectionIds: connections.map((connection) => connection.id),
            documentBaseIds: payload.documentBaseIds,
          },
        },
      });
      await syncCreatedScheduledTask({ db, workflowClient, task });
      return c.json(task, 201);
    },
  );
}

function packMutationHttpError(error: unknown): HTTPException {
  if (error instanceof PackManifestChangedError) {
    return new HTTPException(409, {
      message: "The Pack manifest changed after preview. Review the updated installation plan.",
    });
  }
  if (error instanceof PackOperationClaimLostError) {
    return new HTTPException(409, {
      message: "This Pack operation was recovered by another request; review the current state",
    });
  }
  if (error instanceof PackOperationIdempotencyError) {
    return new HTTPException(409, {
      message: "Pack idempotency key was already used",
    });
  }
  if (error instanceof PackOperationInProgressError) {
    return new HTTPException(409, {
      message: "Another Pack operation is still running; wait for it to finish, then review again",
    });
  }
  if (error instanceof PackInstallationVersionConflictError) {
    return new HTTPException(409, {
      message: "Pack installation changed after preview",
    });
  }
  if (error instanceof PackInstallationVersionRequiredError) {
    return new HTTPException(400, {
      message: "Updating or repairing a Pack requires the previewed installation version",
    });
  }
  if (error instanceof HTTPException) return error;
  return new HTTPException(422, {
    message: error instanceof Error ? error.message : "Pack mutation failed",
  });
}

function packFailureCode(error: unknown): string {
  if (error instanceof HTTPException) return `http_${error.status}`;
  if (error instanceof PackComponentResolutionError) return `component_${error.status}`;
  if (error instanceof CapabilityComponentVersionConflictError) return "component_version_conflict";
  return "component_install_failed";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function requirePack(db: ApiRouteDeps["db"], workspaceId: string, packId: string) {
  const pack = await resolveCapabilityPack(db, workspaceId, packId);
  if (!pack) {
    throw new HTTPException(404, { message: "pack not found" });
  }
  return pack;
}

async function resolveSocialConnections(
  db: ApiRouteDeps["db"],
  workspaceId: string,
  connectionIds: string[],
  subjectId: string,
): Promise<SocialConnection[]> {
  const ids = [...new Set(connectionIds)];
  const connections =
    ids.length > 0
      ? await Promise.all(
          ids.map(async (id) => {
            const connection = await getSocialConnection(db, workspaceId, id, subjectId);
            if (!connection) {
              throw new HTTPException(422, {
                message: `unknown social connection: ${id}`,
              });
            }
            return connection;
          }),
        )
      : (await listSocialConnections(db, workspaceId, 500, subjectId)).filter(
          (connection) => connection.status === "connected",
        );
  const inactive = connections.find((connection) => connection.status !== "connected");
  if (inactive) {
    throw new HTTPException(422, {
      message: `social connection ${inactive.id} is ${inactive.status}`,
    });
  }
  return connections;
}

async function validateDocumentBaseIds(
  db: ApiRouteDeps["db"],
  workspaceId: string,
  documentBaseIds: string[],
): Promise<void> {
  for (const baseId of [...new Set(documentBaseIds)]) {
    const base = await getDocumentBase(db, workspaceId, baseId);
    if (!base) {
      throw new HTTPException(422, {
        message: `unknown document base: ${baseId}`,
      });
    }
  }
}
