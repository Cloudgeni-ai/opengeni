// Knowledge bank REST: the workspace's living self-model. Reads reuse the
// documents:search permission (the bank describes the same knowledge corpus);
// writes reuse documents:manage. Human REST access is NOT gated by the
// settings.knowledgeBankEnabled flag — that flag gates only agent surfaces
// (charter injection + MCP tools), mirroring workspace memory.
import {
  KnowledgeBankResponse,
  UpdateWorkspaceCharterRequest,
  WorkspaceCharterVersionsResponse,
} from "@opengeni/contracts";
import {
  aggregateKnowledgeMap,
  getKnowledgeBankState,
  getLatestWorkspaceCharter,
  listWorkspaceCharterVersions,
  markKnowledgeBankDirtyScoped,
  saveWorkspaceCharterVersion,
  setKnowledgeBankLocked,
} from "@opengeni/db";
import { synthesizeKnowledgeBank } from "@opengeni/documents";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";

export function registerKnowledgeBankRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;

  app.get("/v1/workspaces/:workspaceId/knowledge-bank", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const [charter, map, state] = await Promise.all([
      getLatestWorkspaceCharter(db, workspaceId),
      aggregateKnowledgeMap(db, workspaceId),
      getKnowledgeBankState(db, workspaceId),
    ]);
    return c.json(KnowledgeBankResponse.parse({ charter, map, state }));
  });

  app.get("/v1/workspaces/:workspaceId/knowledge-bank/versions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HTTPException(400, { message: "limit must be an integer between 1 and 100" });
    }
    return c.json(
      WorkspaceCharterVersionsResponse.parse({
        versions: await listWorkspaceCharterVersions(db, workspaceId, limit),
      }),
    );
  });

  // Human edit: appends a NEW charter version (never rewrites history), carrying
  // the machine narrative (overview/baseNotes/gaps) of the latest version
  // forward, and/or toggles the machine-overwrite lock.
  app.patch("/v1/workspaces/:workspaceId/knowledge-bank", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = UpdateWorkspaceCharterRequest.parse(await c.req.json());
    let state = await getKnowledgeBankState(db, workspaceId);
    if (payload.locked !== undefined) {
      state = await setKnowledgeBankLocked(db, {
        accountId: grant.accountId,
        workspaceId,
        locked: payload.locked,
      });
    }
    let charter = await getLatestWorkspaceCharter(db, workspaceId);
    if (payload.purpose !== undefined || payload.goals !== undefined) {
      const purpose = payload.purpose ?? charter?.purpose;
      if (!purpose) {
        throw new HTTPException(422, {
          message: "a first charter version needs a purpose",
        });
      }
      charter = await saveWorkspaceCharterVersion(db, {
        accountId: grant.accountId,
        workspaceId,
        purpose,
        goals: payload.goals ?? charter?.goals ?? [],
        overview: charter?.overview ?? null,
        baseNotes: charter?.baseNotes ?? [],
        gaps: charter?.gaps ?? [],
        changelog: "Edited by a human.",
        updatedBy: grant.subjectId,
        model: null,
      });
    }
    const map = await aggregateKnowledgeMap(db, workspaceId);
    return c.json(KnowledgeBankResponse.parse({ charter, map, state }));
  });

  // Refresh now: synthesize inline (instant UX, works without the worker), and
  // mark dirty first so a crash mid-synthesis still gets swept up later.
  app.post("/v1/workspaces/:workspaceId/knowledge-bank/refresh", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    await markKnowledgeBankDirtyScoped(db, { accountId: grant.accountId, workspaceId });
    const result = await synthesizeKnowledgeBank(db, deps.settings, {
      accountId: grant.accountId,
      workspaceId,
      updatedBy: grant.subjectId,
    });
    if (result.skipped === "locked") {
      throw new HTTPException(409, {
        message: "knowledge bank is locked; unlock it to refresh",
      });
    }
    const [charter, map, state] = await Promise.all([
      getLatestWorkspaceCharter(db, workspaceId),
      aggregateKnowledgeMap(db, workspaceId),
      getKnowledgeBankState(db, workspaceId),
    ]);
    return c.json(KnowledgeBankResponse.parse({ charter, map, state }));
  });
}
