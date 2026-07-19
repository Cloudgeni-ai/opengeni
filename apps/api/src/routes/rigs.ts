import {
  CreateRigRequest,
  ProposeRigChangeRequest,
  RigDefinitionEditPayload,
  UpdateRigRequest,
} from "@opengeni/contracts";
import {
  beginRigChangeVerificationAttempt,
  listRigs,
  RigChangeAlreadyVerifyingError,
  RigChangeTransitionError,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant, requirePermission } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  activateRigVersionForApi,
  createRigForApi,
  createRigVersionForApi,
  deleteRigForApi,
  listRigChangesForApi,
  listRigVersionsForApi,
  promoteVerifiedRigChangeForApi,
  proposeRigChangeForApi,
  requireRigChangeForApi,
  requireRigForApi,
  updateRigForApi,
} from "@opengeni/core";
import { boundedLimit } from "../http/common";

export function registerRigRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, workflowClient } = deps;

  async function startChangeVerification(workspaceId: string, changeId: string): Promise<unknown> {
    const startedAt = new Date().toISOString();
    let change;
    try {
      change = await beginRigChangeVerificationAttempt(db, workspaceId, changeId, {
        startedAt,
        allowAlreadyVerifying: true,
      });
    } catch (error) {
      if (
        error instanceof RigChangeAlreadyVerifyingError ||
        error instanceof RigChangeTransitionError
      ) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
    const attempt = change.verification?.attempt;
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
      throw new HTTPException(500, { message: "rig verification attempt was not persisted" });
    }
    await workflowClient.startRigVerification({
      workspaceId,
      changeId,
      attempt,
      workflowId: `rig-verification-change-${changeId}-attempt-${attempt}`,
    });
    return change;
  }

  async function startVersionVerification(workspaceId: string, versionId: string): Promise<void> {
    await workflowClient.startRigVerification({
      workspaceId,
      versionId,
      workflowId: `rig-verification-version-${versionId}-${crypto.randomUUID()}`,
    });
  }

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

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/versions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    const payload = RigDefinitionEditPayload.parse(await c.req.json());
    return c.json(await createRigVersionForApi({ db }, grant, rig, payload), 201);
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
    return c.json(
      await listRigChangesForApi({ db }, workspaceId, rig.id, boundedLimit(c.req.query("limit"))),
    );
  });

  // rigs:use may propose and verify, but never activate. Both change kinds land
  // verified/awaiting-manager on green.
  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId);
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    const request = ProposeRigChangeRequest.parse(await c.req.json());
    requirePermission(grant, request.kind === "definition_edit" ? "rigs:manage" : "rigs:use");
    const { change, created } = await proposeRigChangeForApi({ db }, grant, rig, request);
    // A retry after the workflow start became ambiguous repairs the exact
    // DB-committed attempt. A retry after a terminal/verified outcome is a pure
    // read: never create a fresh attempt implicitly.
    const shouldEnsureWorkflow =
      created ||
      change.status === "verifying" ||
      (change.status === "proposed" && change.verification?.passed !== true);
    const result = shouldEnsureWorkflow
      ? await startChangeVerification(workspaceId, change.id)
      : change;
    return created ? c.json(result, 201) : c.json(result, 200);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    return c.json(
      await requireRigChangeForApi(db, workspaceId, c.req.param("rigId"), c.req.param("changeId")),
    );
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/verify", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const change = await requireRigChangeForApi(
      db,
      workspaceId,
      c.req.param("rigId"),
      c.req.param("changeId"),
    );
    const verifying = await startChangeVerification(workspaceId, change.id);
    return c.json(verifying, 202);
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/promote", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    const change = await requireRigChangeForApi(db, workspaceId, rig.id, c.req.param("changeId"));
    const promoted = await promoteVerifiedRigChangeForApi({ db }, grant, rig, change);
    return promoted.promoted ? c.json(promoted.version, 201) : c.json(promoted.version, 200);
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/verify", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, workspaceId, c.req.param("rigId"));
    if (!rig.activeVersion) {
      return c.json({ error: "rig has no active version" }, 422);
    }
    if (rig.activeVersion.checks.length === 0) {
      return c.json({ error: "rig has no checks configured" }, 422);
    }
    await startVersionVerification(workspaceId, rig.activeVersion.id);
    return c.json({ ok: true, versionId: rig.activeVersion.id }, 202);
  });
}
