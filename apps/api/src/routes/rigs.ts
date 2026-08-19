import {
  CreateRigRequest,
  ProposeRigChangeRequest,
  RigDefinitionEditPayload,
  UpdateRigRequest,
} from "@opengeni/contracts";
import {
  beginRigChangeVerificationAttempt,
  listRigs,
  RigChangeTransitionError,
} from "@opengeni/db";
import type { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requirePermission,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  activateRigVersionForApi,
  createRigForApi,
  createRigVersionForApi,
  deleteRigForApi,
  listRigChangesForApi,
  listRigVersionsForApi,
  promoteVerifiedDefinitionEditChangeForApi,
  proposeRigChangeForApi,
  requireRigChangeForApi,
  requireRigForApi,
  updateRigForApi,
} from "@opengeni/core";
import { boundedLimit } from "../http/common";

export function registerRigRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, workflowClient } = deps;

  async function requireRigMutation(
    c: Context,
    workspaceId: string,
    permission: "rigs:manage" | "rigs:use",
  ) {
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId, permission);
    const rigId = c.req.param("rigId");
    if (!rigId) {
      throw new HTTPException(400, { message: "rig id is required" });
    }
    const rig = await requireRigForApi(db, authorization.grant, rigId);
    if (
      rig.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") !== true
    ) {
      throw new HTTPException(403, {
        message: "missing permission: account:admin",
      });
    }
    return { authorization, grant: authorization.grant, rig };
  }

  async function startChangeVerification(
    workspaceId: string,
    changeId: string,
  ): Promise<{
    change: Awaited<ReturnType<typeof beginRigChangeVerificationAttempt>>;
    started: boolean;
  }> {
    const startedAt = new Date().toISOString();
    let change;
    try {
      change = await beginRigChangeVerificationAttempt(db, workspaceId, changeId, {
        startedAt,
        // Reuse the existing attempt after an ambiguous Temporal start. Its
        // deterministic workflow id turns this into an idempotent recovery.
        allowAlreadyVerifying: true,
      });
    } catch (error) {
      if (error instanceof RigChangeTransitionError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
    const attempt =
      typeof change.verification?.attempt === "number" ? change.verification.attempt : Date.now();
    try {
      await workflowClient.startRigVerification({
        workspaceId,
        changeId,
        workflowId: `rig-verification-change-${changeId}-attempt-${attempt}`,
      });
      return { change, started: true };
    } catch (error) {
      // The verifying transition already committed. Keep its deterministic
      // attempt identity retryable instead of reporting an opaque 5xx after a
      // durable mutation or inventing a second attempt after an ambiguous start.
      deps.observability?.warn("rig change verification start failed", {
        workspaceId,
        changeId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      return { change, started: false };
    }
  }

  async function startVersionVerification(
    workspaceId: string,
    versionId: string,
    workflowId = `rig-verification-version-${versionId}-${crypto.randomUUID()}`,
  ): Promise<void> {
    await workflowClient.startRigVerification({
      workspaceId,
      versionId,
      workflowId,
    });
  }

  async function tryStartInitialVersionVerification(
    workspaceId: string,
    versionId: string,
  ): Promise<boolean> {
    try {
      await startVersionVerification(
        workspaceId,
        versionId,
        `rig-verification-version-${versionId}-initial`,
      );
      return true;
    } catch (error) {
      // Creation already committed. The rig remains fully usable through its
      // runtime setup fallback and can be re-verified explicitly; never turn a
      // successful create into an unretryable 5xx because Temporal was down.
      deps.observability?.warn("initial rig provider-image verification start failed", {
        workspaceId,
        versionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  app.get("/v1/workspaces/:workspaceId/rigs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    return c.json(await listRigs(db, grant));
  });

  app.post("/v1/workspaces/:workspaceId/rigs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const grant = authorization.grant;
    requirePermission(grant, "rigs:manage");
    const payload = CreateRigRequest.parse(await c.req.json());
    const allowOrganization =
      payload.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") === true;
    if (payload.scope === "organization" && !allowOrganization) {
      throw new HTTPException(403, {
        message: "missing permission: account:admin",
      });
    }
    const rig = await createRigForApi({ db }, grant, payload, {
      allowOrganization,
    });
    if (rig.activeVersion) {
      const started = await tryStartInitialVersionVerification(workspaceId, rig.activeVersion.id);
      if (!started) c.header("OpenGeni-Rig-Verification", "deferred");
    }
    return c.json(rig, 201);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    return c.json(await requireRigForApi(db, grant, c.req.param("rigId")));
  });

  app.patch("/v1/workspaces/:workspaceId/rigs/:rigId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const grant = authorization.grant;
    requirePermission(grant, "rigs:manage");
    const rig = await requireRigForApi(db, grant, c.req.param("rigId"));
    const allowOrganization =
      rig.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") === true;
    if (rig.scope === "organization" && !allowOrganization) {
      throw new HTTPException(403, {
        message: "missing permission: account:admin",
      });
    }
    const payload = UpdateRigRequest.parse(await c.req.json());
    return c.json(await updateRigForApi({ db }, grant, rig, payload, { allowOrganization }));
  });

  app.delete("/v1/workspaces/:workspaceId/rigs/:rigId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const grant = authorization.grant;
    requirePermission(grant, "rigs:manage");
    const rig = await requireRigForApi(db, grant, c.req.param("rigId"));
    const allowOrganization =
      rig.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") === true;
    if (rig.scope === "organization" && !allowOrganization) {
      throw new HTTPException(403, {
        message: "missing permission: account:admin",
      });
    }
    await deleteRigForApi({ db }, grant, rig, { allowOrganization });
    return c.json({ ok: true });
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/versions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, grant, c.req.param("rigId"));
    return c.json(await listRigVersionsForApi({ db }, rig.workspaceId, rig.id));
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/versions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant, rig } = await requireRigMutation(c, workspaceId, "rigs:manage");
    const payload = RigDefinitionEditPayload.parse(await c.req.json());
    const version = await createRigVersionForApi({ db }, grant, rig, payload);
    const started = await tryStartInitialVersionVerification(rig.workspaceId, version.id);
    if (!started) c.header("OpenGeni-Rig-Verification", "deferred");
    return c.json(version, 201);
  });

  // Rollback / promote-activate: flips which existing version is active.
  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/versions/:versionId/activate", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant, rig } = await requireRigMutation(c, workspaceId, "rigs:manage");
    const version = await activateRigVersionForApi({ db }, grant, rig, c.req.param("versionId"));
    return c.json(version);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/changes", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, grant, c.req.param("rigId"));
    return c.json(
      await listRigChangesForApi(
        { db },
        rig.workspaceId,
        rig.id,
        boundedLimit(c.req.query("limit")),
      ),
    );
  });

  // Propose a change (rigs:use — the additive, agent-trusted path). The change
  // is recorded `proposed`; verification + auto-merge (setup_append) and the
  // promote gate (definition_edit) land in M4.
  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant, rig } = await requireRigMutation(c, workspaceId, "rigs:use");
    const request = ProposeRigChangeRequest.parse(await c.req.json());
    const change = await proposeRigChangeForApi({ db }, grant, rig, request);
    const verification = await startChangeVerification(rig.workspaceId, change.id);
    if (!verification.started) c.header("OpenGeni-Rig-Verification", "deferred");
    return c.json(verification.change, 201);
  });

  app.get("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "rigs:use");
    const rig = await requireRigForApi(db, grant, c.req.param("rigId"));
    return c.json(
      await requireRigChangeForApi(db, rig.workspaceId, rig.id, c.req.param("changeId")),
    );
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/verify", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { rig } = await requireRigMutation(c, workspaceId, "rigs:use");
    const change = await requireRigChangeForApi(
      db,
      rig.workspaceId,
      rig.id,
      c.req.param("changeId"),
    );
    const verification = await startChangeVerification(rig.workspaceId, change.id);
    if (!verification.started) c.header("OpenGeni-Rig-Verification", "deferred");
    return c.json(verification.change, 202);
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/promote", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant, rig } = await requireRigMutation(c, workspaceId, "rigs:manage");
    const change = await requireRigChangeForApi(
      db,
      rig.workspaceId,
      rig.id,
      c.req.param("changeId"),
    );
    const promoted = await promoteVerifiedDefinitionEditChangeForApi({ db }, grant, rig, change);
    return c.json(promoted.version, 201);
  });

  app.post("/v1/workspaces/:workspaceId/rigs/:rigId/verify", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { rig } = await requireRigMutation(c, workspaceId, "rigs:use");
    if (!rig.activeVersion) {
      return c.json({ error: "rig has no active version" }, 422);
    }
    await startVersionVerification(rig.workspaceId, rig.activeVersion.id);
    return c.json({ ok: true, versionId: rig.activeVersion.id }, 202);
  });
}
