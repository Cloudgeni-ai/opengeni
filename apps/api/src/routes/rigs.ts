import { CreateRigRequest, ProposeRigChangeRequest, UpdateRigRequest } from "@opengeni/contracts";
import { listRigs } from "@opengeni/db";
import type { Hono } from "hono";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  activateRigVersionForApi,
  createRigForApi,
  deleteRigForApi,
  listRigChangesForApi,
  listRigVersionsForApi,
  proposeRigChangeForApi,
  requireRigChangeForApi,
  requireRigForApi,
  updateRigForApi,
} from "@opengeni/core";
import { boundedLimit } from "../http/common";

export function registerRigRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;

  app.get("/v1/workspaces/:workspaceId/rigs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    return c.json(await listRigs(db, workspaceId));
  });

  app.post("/v1/workspaces/:workspaceId/rigs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const payload = CreateRigRequest.parse(await c.req.json());
    const rig = await createRigForApi({ db }, grant, payload);
    return c.json(rig, 201);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    return c.json(await requireRigForApi(db, workspaceId, c.req.param("rigId")));
  });

  app.patch("/v1/workspaces/:workspaceId/rigs/:rigId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    const payload = UpdateRigRequest.parse(await c.req.json());
    return c.json(await updateRigForApi({ db }, grant, rig, payload));
  });

  app.delete("/v1/workspaces/:workspaceId/rigs/:rigId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    await deleteRigForApi({ db }, grant, rig);
    return c.json({ ok: true });
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/versions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    return c.json(await listRigVersionsForApi({ db }, workspaceId, rig.id));
  });

  // Rollback / promote-activate: flips which existing version is active.
  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/versions/:versionId/activate", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    const version = await activateRigVersionForApi({ db }, grant, rig, c.req.param("versionId"));
    return c.json(version);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/changes", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    return c.json(await listRigChangesForApi({ db }, workspaceId, rig.id, boundedLimit(c.req.query("limit"))));
  });

  // Propose a change (rigs:use — the additive, agent-trusted path). The change
  // is recorded `proposed`; verification + auto-merge (setup_append) and the
  // promote gate (definition_edit) land in M4.
  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    const request = ProposeRigChangeRequest.parse(await c.req.json());
    const change = await proposeRigChangeForApi({ db }, grant, rig, request);
    return c.json(change, 201);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    return c.json(await requireRigChangeForApi(db, workspaceId, c.req.param("rigId"), c.req.param("changeId")));
  });

  // TODO-M4: POST /rigs/:rigId/changes/:changeId/verify (rigs:use) — trigger the
  // non-billable rig-CI verification workflow (clean-replay in a throwaway box).
  // TODO-M4: POST /rigs/:rigId/changes/:changeId/promote (rigs:manage) — mint the
  // next version from a green definition_edit change.
  // TODO-M4: POST /rigs/:rigId/verify (rigs:use) — re-verify the active version's
  // checks on demand.
}
