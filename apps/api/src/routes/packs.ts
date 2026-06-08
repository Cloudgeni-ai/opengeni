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
import type { ApiRouteDeps } from "../dependencies";
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

  app.get("/v1/packs", async (c) => {
    return c.json({
      packs: listCapabilityPacks(),
      installations: await listPackInstallations(db),
    });
  });

  app.get("/v1/packs/installations", async (c) => {
    return c.json(await listPackInstallations(db));
  });

  app.get("/v1/packs/:packId", async (c) => {
    const pack = requirePack(c.req.param("packId"));
    return c.json({
      pack,
      installation: await getPackInstallation(db, pack.id),
    });
  });

  app.post("/v1/packs/:packId/enable", async (c) => {
    const pack = requirePack(c.req.param("packId"));
    const existing = await getPackInstallation(db, pack.id);
    const payload = EnablePackRequest.parse(await c.req.json());
    const installation = await enablePackInstallation(db, {
      packId: pack.id,
      metadata: {
        ...payload.metadata,
        packVersion: pack.version,
      },
    });
    return c.json(installation, existing ? 200 : 201);
  });

  app.post("/v1/packs/marketing-social-daily-analysis/scheduled-tasks", async (c) => {
    const pack = requirePack(MARKETING_SOCIAL_PACK_ID);
    const installation = await getPackInstallation(db, pack.id);
    if (installation?.status !== "active") {
      throw new HTTPException(409, { message: "enable the marketing social pack before creating its scheduled tasks" });
    }
    const payload = MarketingDailyAnalysisTaskRequest.parse(await c.req.json());
    const connections = await resolveSocialConnections(db, payload.connectionIds);
    if (connections.length === 0) {
      throw new HTTPException(422, { message: "at least one connected social account is required" });
    }
    await validateDocumentBaseIds(db, payload.documentBaseIds);
    const agentConfig = buildMarketingDailyAnalysisAgentConfig({
      connections,
      documentBaseIds: payload.documentBaseIds,
      ...(payload.promptInstructions ? { promptInstructions: payload.promptInstructions } : {}),
    });
    const task = await createValidatedScheduledTask({
      settings,
      db,
      objectStorage,
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

async function resolveSocialConnections(db: ApiRouteDeps["db"], connectionIds: string[]): Promise<SocialConnection[]> {
  const ids = [...new Set(connectionIds)];
  const connections = ids.length > 0
    ? await Promise.all(ids.map(async (id) => {
        const connection = await getSocialConnection(db, id);
        if (!connection) {
          throw new HTTPException(422, { message: `unknown social connection: ${id}` });
        }
        return connection;
      }))
    : (await listSocialConnections(db, 500)).filter((connection) => connection.status === "connected");
  const inactive = connections.find((connection) => connection.status !== "connected");
  if (inactive) {
    throw new HTTPException(422, { message: `social connection ${inactive.id} is ${inactive.status}` });
  }
  return connections;
}

async function validateDocumentBaseIds(db: ApiRouteDeps["db"], documentBaseIds: string[]): Promise<void> {
  for (const baseId of [...new Set(documentBaseIds)]) {
    const base = await getDocumentBase(db, baseId);
    if (!base) {
      throw new HTTPException(422, { message: `unknown document base: ${baseId}` });
    }
  }
}
