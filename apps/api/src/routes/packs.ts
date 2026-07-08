import {
  EnablePackRequest,
  MarketingDailyAnalysisTaskRequest,
  RegisterCapabilityPackRequest,
  type SocialConnection,
} from "@opengeni/contracts";
import {
  deleteWorkspacePack,
  disableCapabilityInstallation,
  enablePackInstallation,
  getCapabilityInstallation,
  getPackInstallation,
  getWorkspacePack,
  getSocialConnection,
  listPackInstallations,
  listSocialConnections,
  registerWorkspacePack,
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
  isBuiltInCapabilityPack,
  listWorkspaceCapabilityPacks,
  MARKETING_SOCIAL_PACK_ID,
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
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
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const packId = c.req.param("packId");
    if (isBuiltInCapabilityPack(packId)) {
      throw new HTTPException(409, { message: "built-in packs cannot be unregistered" });
    }
    if (!(await getWorkspacePack(db, workspaceId, packId))) {
      throw new HTTPException(404, { message: "pack not found" });
    }
    // Disable installations before deleting the registration so a crash in
    // between can never orphan an active installation whose manifest is
    // gone; the capability installation row for pack:{packId} would
    // otherwise keep a future re-registration looking enabled.
    const installation = await getPackInstallation(db, workspaceId, packId);
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

  app.post("/v1/workspaces/:workspaceId/packs/:packId/enable", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const pack = await requirePack(db, workspaceId, c.req.param("packId"));
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
      const connections = await resolveSocialConnections(db, workspaceId, payload.connectionIds);
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
): Promise<SocialConnection[]> {
  const ids = [...new Set(connectionIds)];
  const connections =
    ids.length > 0
      ? await Promise.all(
          ids.map(async (id) => {
            const connection = await getSocialConnection(db, workspaceId, id);
            if (!connection) {
              throw new HTTPException(422, { message: `unknown social connection: ${id}` });
            }
            return connection;
          }),
        )
      : (await listSocialConnections(db, workspaceId, 500)).filter(
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
      throw new HTTPException(422, { message: `unknown document base: ${baseId}` });
    }
  }
}
