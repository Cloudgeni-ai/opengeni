import {
  EnablePackRequest,
  MarketingDailyAnalysisTaskRequest,
  type SocialConnection,
} from "@opengeni/contracts";
import {
  enablePackInstallation,
  getPackInstallation,
  getSocialConnection,
  listPackInstallations,
  listSocialConnections,
} from "@opengeni/db";
import { getDocumentBase } from "@opengeni/documents";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "../access";
import { requireLimit } from "../billing/limits";
import type { ApiRouteDeps } from "../dependencies";
import { validateEnvironmentAttachment } from "../domain/environments";
import {
  buildMarketingDailyAnalysisAgentConfig,
  getCapabilityPack,
  listCapabilityPacks,
  MARKETING_SOCIAL_PACK_ID,
} from "../domain/packs";
import {
  createValidatedScheduledTask,
  syncCreatedScheduledTask,
} from "../domain/scheduled-tasks";

export function registerPackRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db, objectStorage, workflowClient } = deps;

  app.get("/v1/workspaces/:workspaceId/packs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json({
      packs: listCapabilityPacks(),
      installations: await listPackInstallations(db, workspaceId),
    });
  });

  app.get("/v1/workspaces/:workspaceId/packs/installations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(await listPackInstallations(db, workspaceId));
  });

  app.get("/v1/workspaces/:workspaceId/packs/:packId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const pack = requirePack(c.req.param("packId"));
    return c.json({
      pack,
      installation: await getPackInstallation(db, workspaceId, pack.id),
    });
  });

  app.post("/v1/workspaces/:workspaceId/packs/:packId/enable", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const pack = requirePack(c.req.param("packId"));
    const existing = await getPackInstallation(db, workspaceId, pack.id);
    const payload = EnablePackRequest.parse(await c.req.json());
    if (pack.environment?.required && !payload.environmentId) {
      throw new HTTPException(422, { message: "this pack requires an environment attachment; pass environmentId" });
    }
    if (payload.environmentId) {
      const environment = await validateEnvironmentAttachment({ settings, db }, grant, workspaceId, payload.environmentId);
      const missing = (pack.environment?.requiredVariables ?? [])
        .filter((name) => !environment.variables.some((variable) => variable.name === name));
      if (missing.length > 0) {
        throw new HTTPException(422, { message: `environment is missing required variable(s): ${missing.join(", ")}` });
      }
    }
    const installation = await enablePackInstallation(db, {
      accountId: grant.accountId,
      workspaceId,
      packId: pack.id,
      metadata: {
        ...payload.metadata,
        packVersion: pack.version,
        ...(payload.environmentId ? { environmentId: payload.environmentId } : {}),
      },
    });
    return c.json(installation, existing ? 200 : 201);
  });

  app.post("/v1/workspaces/:workspaceId/packs/marketing-social-daily-analysis/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const pack = requirePack(MARKETING_SOCIAL_PACK_ID);
    const installation = await getPackInstallation(db, workspaceId, pack.id);
    if (installation?.status !== "active") {
      throw new HTTPException(409, { message: "enable the marketing social pack before creating its scheduled tasks" });
    }
    const payload = MarketingDailyAnalysisTaskRequest.parse(await c.req.json());
    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "schedule:create", quantity: 1 });
    const connections = await resolveSocialConnections(db, workspaceId, payload.connectionIds);
    if (connections.length === 0) {
      throw new HTTPException(422, { message: "at least one connected social account is required" });
    }
    await validateDocumentBaseIds(db, workspaceId, payload.documentBaseIds);
    const agentConfig = buildMarketingDailyAnalysisAgentConfig({
      connections,
      documentBaseIds: payload.documentBaseIds,
      ...(payload.promptInstructions ? { promptInstructions: payload.promptInstructions } : {}),
    });
    // Installation-inherited environment attachment: it was authorized with
    // environments:use at pack-enable time, so the scheduled_tasks:manage
    // caller here is not re-checked for that permission.
    const installationEnvironmentId = typeof installation.metadata.environmentId === "string"
      ? installation.metadata.environmentId
      : undefined;
    const task = await createValidatedScheduledTask({
      settings,
      db,
      objectStorage,
      grant,
      environmentPreauthorized: true,
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
        ...(installationEnvironmentId ? { environmentId: installationEnvironmentId } : {}),
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
  });
}

function requirePack(packId: string) {
  const pack = getCapabilityPack(packId);
  if (!pack) {
    throw new HTTPException(404, { message: "pack not found" });
  }
  return pack;
}

async function resolveSocialConnections(db: ApiRouteDeps["db"], workspaceId: string, connectionIds: string[]): Promise<SocialConnection[]> {
  const ids = [...new Set(connectionIds)];
  const connections = ids.length > 0
    ? await Promise.all(ids.map(async (id) => {
        const connection = await getSocialConnection(db, workspaceId, id);
        if (!connection) {
          throw new HTTPException(422, { message: `unknown social connection: ${id}` });
        }
        return connection;
      }))
    : (await listSocialConnections(db, workspaceId, 500)).filter((connection) => connection.status === "connected");
  const inactive = connections.find((connection) => connection.status !== "connected");
  if (inactive) {
    throw new HTTPException(422, { message: `social connection ${inactive.id} is ${inactive.status}` });
  }
  return connections;
}

async function validateDocumentBaseIds(db: ApiRouteDeps["db"], workspaceId: string, documentBaseIds: string[]): Promise<void> {
  for (const baseId of [...new Set(documentBaseIds)]) {
    const base = await getDocumentBase(db, workspaceId, baseId);
    if (!base) {
      throw new HTTPException(422, { message: `unknown document base: ${baseId}` });
    }
  }
}
