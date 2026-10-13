// apps/api/src/routes/machines.ts — the M10 Machines-dashboard + per-machine
// metrics-series ROUTES. Mirrors registerEnrollmentRoutes: thin
// routes over a focused service (../sandbox/machines.ts), requireAccessGrant
// BEFORE any work, the whole router gated behind sandboxSelfhostedEnabled
// (default OFF → 404, invisible). Both routes need perm enrollments:read.
//
//   GET /v1/workspaces/:ws/machines[?sessionId=...]  -> MachinesResponse
//     The dashboard list: the workspace's enrolled selfhosted machines (heartbeat
//     state + latest metrics + sharedSessionCount) and, when sessionId is
//     supplied, the session's synthetic Modal group box + the active-sandbox
//     pointer. This GET does not ControlRpc-ping.
//
//   GET /v1/workspaces/:ws/machines/:enrollmentId/metrics/series?window=1h
//     -> { samples: MetricSample[] }
//     The downsampled (~1/min) history for ONE machine over a time window.

import {
  ChangeMachineAudienceRequest,
  MachineAudiencePreviewRequest,
  OpenMachinePrivacySettingsRequest,
  MachineMetricsSeriesResponse,
  MachineOperationPolicy,
  MachinesResponse,
  SwapActiveSandboxRequest,
  SwapActiveSandboxResponse,
  UpdateMachineOperationPolicyRequest,
  UpdateMachineAgentResponse,
} from "@opengeni/contracts";
import {
  changeMachineAudience,
  getLiveEnrollmentConnection,
  listEnrollments,
  previewMachineAudienceChange,
  readMachineMetricsSeries,
  requireSession,
  updateEnrollmentOperationPolicy,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  grantHasAgentAttemptAuthority,
  mayStartOnlyMe,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildFleetContextForSession, swapActiveSandbox } from "@opengeni/core";
import {
  enableMachineScreenControl,
  enrollmentAccess,
  MachineNotActiveError,
  openMachinePrivacySettings,
} from "../sandbox/screen-control";
import { listMachines, metricRowToSample } from "../sandbox/machines";
import { requestAgentUpdate } from "../sandbox/agent-update";
import {
  machineAudienceChangeResponse,
  machineAudiencePreview,
  machineAudienceRefusalError,
  machineAudienceRequestFor,
} from "../sandbox/machine-audience";
import { ensureSessionGroupReady as ensureViewerSessionGroupReady } from "../sandbox/viewer";
import { parseRequestJson } from "../http/request-body";

// The supported series windows → milliseconds. An unknown/absent window defaults
// to 1h (the default). Bounded so a caller cannot request an unbounded
// scan; longer ranges are a later concern (retention is ~N days).
const SERIES_WINDOWS_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};
const DEFAULT_SERIES_WINDOW_MS = SERIES_WINDOWS_MS["1h"]!;

export function registerMachineRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db, bus } = deps;

  // The whole surface is behind sandboxSelfhostedEnabled. A 404 (not 403) keeps it
  // invisible while disabled — it does not exist for this deployment yet.
  function assertSelfhostedEnabled(): void {
    if (!settings.sandboxSelfhostedEnabled) {
      throw new HTTPException(404, {
        message: "selfhosted machines are not enabled for this deployment",
      });
    }
  }

  async function requireScopedEnrollment(
    grant: Awaited<ReturnType<typeof requireAccessGrant>>,
    enrollmentId: string,
  ) {
    const enrollment = (await listEnrollments(db, grant, { status: "active" })).find(
      (candidate) => candidate.id === enrollmentId,
    );
    if (!enrollment) {
      throw new HTTPException(404, { message: "machine not found in this access scope" });
    }
    return enrollment;
  }

  // ── GET /workspaces/:ws/machines (the dashboard list) ───────────────────────
  app.get("/v1/workspaces/:workspaceId/machines", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:read");
    assertSelfhostedEnabled();
    // sessionId is OPTIONAL: present → an in-session view (synthetic group box +
    // active pointer); absent → the pure workspace dashboard.
    const sessionId = c.req.query("sessionId") ?? null;
    const response = await listMachines(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        sessionId,
      },
    );
    return c.json(MachinesResponse.parse(response));
  });

  // ── GET /workspaces/:ws/machines/:enrollmentId/metrics/series ───────────────
  app.get("/v1/workspaces/:workspaceId/machines/:enrollmentId/metrics/series", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:read");
    assertSelfhostedEnabled();
    const enrollmentId = c.req.param("enrollmentId");
    // Validate the machine belongs to this workspace (RLS already scopes the read,
    // but a clear 404 beats an empty series for an unknown/cross-workspace id).
    const enrollment = await requireScopedEnrollment(grant, enrollmentId);
    const windowMs = SERIES_WINDOWS_MS[c.req.query("window") ?? ""] ?? DEFAULT_SERIES_WINDOW_MS;
    const since = new Date(Date.now() - windowMs);
    const rows = await readMachineMetricsSeries(db, {
      workspaceId: enrollment.workspaceId,
      enrollmentId,
      since,
    });
    return c.json(
      MachineMetricsSeriesResponse.parse({
        samples: rows.map(metricRowToSample),
      }),
    );
  });

  // ── PATCH /workspaces/:ws/machines/:enrollmentId/operation-policy ──────────
  // Null limits deliberately mean unrestricted. The revision is an optimistic
  // concurrency fence so two operators cannot silently overwrite each other.
  app.patch("/v1/workspaces/:workspaceId/machines/:enrollmentId/operation-policy", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "enrollments:manage",
    );
    const grant = authorization.grant;
    assertSelfhostedEnabled();
    const enrollmentId = c.req.param("enrollmentId");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HTTPException(400, {
        message: "operation policy body must be valid JSON",
      });
    }
    const parsed = UpdateMachineOperationPolicyRequest.safeParse(json);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "invalid machine operation policy",
      });
    }
    const body = parsed.data;
    const current = await requireScopedEnrollment(grant, enrollmentId);
    if (
      current.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") !== true
    ) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const updated = await updateEnrollmentOperationPolicy(db, {
      accountId: grant.accountId,
      workspaceId: current.workspaceId,
      enrollmentId,
      subjectId: grant.subjectId,
      expectedRevision: body.expectedRevision,
      memoryMaxBytes: body.memoryMaxBytes,
      memoryHighBytes: body.memoryHighBytes,
      ...(body.cpuMaxMillicores !== undefined ? { cpuMaxMillicores: body.cpuMaxMillicores } : {}),
    });
    if (!updated) {
      throw new HTTPException(409, {
        message: "machine operation policy changed; refresh and retry",
      });
    }
    return c.json(MachineOperationPolicy.parse(updated.operationPolicy));
  });

  // ── Who can use a machine: Workspace or Only me, changed in place ──────────
  // POST .../audience/preview lists what the change would affect with the
  // caller's choices applied; PUT .../audience applies it in one transaction at
  // the previewed generation. The enrollment, sandbox ID, credentials and live
  // connection stay, so chats, schedules and the installed agent keep working.
  // People decide this, not agents: an agent attempt is refused.
  async function requireAudienceCaller(c: Context, workspaceId: string) {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "enrollments:manage",
    );
    const grant = authorization.grant;
    assertSelfhostedEnabled();
    if (grantHasAgentAttemptAuthority(grant)) {
      throw new HTTPException(403, {
        message: "only a person can change who can use a machine",
      });
    }
    return grant;
  }

  // The new owner's Workspace schedules on the machine become Only me when
  // they may have Only me schedules; otherwise they pause.
  async function schedulesMayBeOnlyMe(workspaceId: string, ownerSubjectId: string | null) {
    return ownerSubjectId === null
      ? false
      : await mayStartOnlyMe(db, settings, workspaceId, ownerSubjectId);
  }

  app.post("/v1/workspaces/:workspaceId/machines/:enrollmentId/audience/preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAudienceCaller(c, workspaceId);
    const enrollmentId = c.req.param("enrollmentId");
    const body = await parseRequestJson(c, MachineAudiencePreviewRequest);
    const machine = await requireScopedEnrollment(grant, enrollmentId);
    const { ownerSubjectId } = machineAudienceRequestFor(grant, workspaceId, machine, body);
    const preview = await previewMachineAudienceChange(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      enrollmentId,
      target: body.audience,
      ownerSubjectId,
      schedulesMayBeOnlyMe: await schedulesMayBeOnlyMe(workspaceId, ownerSubjectId),
    });
    if (typeof preview === "string") throw machineAudienceRefusalError(preview);
    return c.json(machineAudiencePreview(preview));
  });

  app.put("/v1/workspaces/:workspaceId/machines/:enrollmentId/audience", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAudienceCaller(c, workspaceId);
    const enrollmentId = c.req.param("enrollmentId");
    const body = await parseRequestJson(c, ChangeMachineAudienceRequest);
    const machine = await requireScopedEnrollment(grant, enrollmentId);
    const { ownerSubjectId } = machineAudienceRequestFor(grant, workspaceId, machine, body);
    const changed = await changeMachineAudience(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      enrollmentId,
      target: body.audience,
      ownerSubjectId,
      schedulesMayBeOnlyMe: await schedulesMayBeOnlyMe(workspaceId, ownerSubjectId),
      expectedGeneration: body.expectedGeneration,
    });
    return c.json(machineAudienceChangeResponse(changed));
  });

  // ── POST /workspaces/:ws/machines/:enrollmentId/screen-control ─────────────
  // Turn screen control on for one connected machine, in place (see
  // ../sandbox/screen-control.ts): record the consent, then have the live agent
  // renew its credentials. Needs enrollments:manage, like connecting the
  // machine; agents holding it call this too (or the
  // connected_machine_enable_screen_control tool). No request body.
  app.post("/v1/workspaces/:workspaceId/machines/:enrollmentId/screen-control", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "enrollments:manage",
    );
    const grant = authorization.grant;
    assertSelfhostedEnabled();
    const enrollmentId = c.req.param("enrollmentId");
    const enrollment = await requireScopedEnrollment(grant, enrollmentId);
    if (
      enrollment.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") !== true
    ) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    try {
      return c.json(
        await enableMachineScreenControl(
          { db, settings, bus, observability: deps.observability },
          {
            enrollment,
            access: enrollmentAccess(enrollment, grant),
            actor: { subjectId: grant.subjectId },
          },
        ),
      );
    } catch (error) {
      if (error instanceof MachineNotActiveError) {
        throw new HTTPException(404, { message: error.message });
      }
      throw error;
    }
  });

  // ── POST /workspaces/:ws/machines/:enrollmentId/privacy-settings ───────────
  // Open one macOS Privacy & Security pane on the connected Mac, so the person
  // only flips the switch for OpenGeni. Opening a pane grants nothing.
  app.post("/v1/workspaces/:workspaceId/machines/:enrollmentId/privacy-settings", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "enrollments:manage",
    );
    const grant = authorization.grant;
    assertSelfhostedEnabled();
    const enrollmentId = c.req.param("enrollmentId");
    const parsed = OpenMachinePrivacySettingsRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid privacy settings request" });
    }
    const enrollment = await requireScopedEnrollment(grant, enrollmentId);
    if (
      enrollment.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") !== true
    ) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    if (enrollment.os !== "macos") {
      throw new HTTPException(422, { message: "privacy settings panes exist only on macOS" });
    }
    return c.json(
      await openMachinePrivacySettings(
        { db, settings, bus, observability: deps.observability },
        { enrollment, access: enrollmentAccess(enrollment, grant), pane: parsed.data.pane },
      ),
    );
  });

  // ── POST /workspaces/:ws/machines/:enrollmentId/update ─────────────────────
  // Reserve one exact-generation operation, ask the authoritative runner to
  // drain and apply the signed promoted release, then let progress events + the
  // successor Hello drive the durable state to completion.
  app.post("/v1/workspaces/:workspaceId/machines/:enrollmentId/update", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "enrollments:manage",
    );
    const grant = authorization.grant;
    assertSelfhostedEnabled();
    const enrollmentId = c.req.param("enrollmentId");
    const visibleEnrollment = await requireScopedEnrollment(grant, enrollmentId);
    if (
      visibleEnrollment.scope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") !== true
    ) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const originWorkspaceId = visibleEnrollment.workspaceId;
    const live = await getLiveEnrollmentConnection(
      db,
      visibleEnrollment.scope === "user" ? grant : originWorkspaceId,
      enrollmentId,
    );
    if (!live || live.id !== enrollmentId || live.workspaceId !== originWorkspaceId) {
      throw new HTTPException(409, {
        message: "machine has no authoritative live agent build",
      });
    }
    const result = await requestAgentUpdate({ db, bus, settings }, live, {
      releaseBaseUrl: settings.publicBaseUrl ?? new URL(c.req.url).origin,
    });
    if (result.kind === "refused") {
      throw new HTTPException(result.status, { message: result.message });
    }
    return c.json(
      UpdateMachineAgentResponse.parse({
        operationId: result.operationId,
        accepted: true,
        targetVersion: result.targetVersion,
      }),
      202,
    );
  });

  // ── POST /workspaces/:ws/sessions/:sessionId/active-sandbox (swap) ───────────
  // The user-authenticated equivalent of the M7 `sandbox_swap` MCP tool: repoint
  // a session's active sandbox under the epoch fence. Same perm as PATCH session
  // (sessions:control); gated behind sandboxSelfhostedEnabled (404 when off, the
  // surface is invisible). All ownership/liveness/epoch validation lives inside
  // swapActiveSandbox — the route only builds the session-scoped FleetContext.
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/active-sandbox", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    assertSelfhostedEnabled();
    const sessionId = c.req.param("sessionId");
    // Registered before the session route module, so its authorization
    // middleware does not cover this path: an agent attempt must pass the
    // core seam (including the 0426 agent-access scope) before it may repoint
    // another session's compute.
    if (grantHasAgentAttemptAuthority(grant)) {
      try {
        await requireSessionAuthorization(deps, grant, {
          sessionId,
          operation: "session.control",
          surface: "http",
        });
      } catch (error) {
        if (error instanceof SessionAuthorizationDeniedError) {
          throw new HTTPException(404, { message: "session not found", cause: error });
        }
        if (error instanceof SessionAuthorizationUnavailableError) {
          throw new HTTPException(503, {
            message: "session authorization is unavailable",
            cause: error,
          });
        }
        throw error;
      }
    }
    const body = await parseRequestJson(c, SwapActiveSandboxRequest);
    const ctx = await buildFleetContextForSession(deps, {
      accountId: grant.accountId,
      workspaceId,
      sessionId,
      subjectId: grant.subjectId,
    });
    const result = await swapActiveSandbox(
      {
        db,
        settings,
        bus,
        ensureSessionGroupReady: async (fleetCtx) => {
          const session = await requireSession(db, fleetCtx.workspaceId, fleetCtx.sessionId);
          return await ensureViewerSessionGroupReady(
            { db, settings, bus },
            {
              accountId: fleetCtx.accountId,
              workspaceId: fleetCtx.workspaceId,
              session,
              subjectId: fleetCtx.subjectId ?? null,
            },
          );
        },
      },
      ctx,
      body.target,
    );
    return c.json(SwapActiveSandboxResponse.parse(result));
  });
}
