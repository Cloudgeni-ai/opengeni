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
  MachineMetricsSeriesResponse,
  MachineOperationPolicy,
  MachinesResponse,
  SwapActiveSandboxRequest,
  SwapActiveSandboxResponse,
  UpdateMachineOperationPolicyRequest,
  UpdateMachineAgentResponse,
} from "@opengeni/contracts";
import {
  advanceEnrollmentAgentUpdate,
  beginEnrollmentAgentUpdate,
  getLiveEnrollmentConnection,
  listEnrollments,
  readMachineMetricsSeries,
  requireSession,
  updateEnrollmentOperationPolicy,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant, requireAccessGrantAuthorization } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildFleetContextForSession, swapActiveSandbox } from "@opengeni/core";
import { listMachines, metricRowToSample } from "../sandbox/machines";
import { ensureSessionGroupReady as ensureViewerSessionGroupReady } from "../sandbox/viewer";
import { ControlRequest, ErrorCode } from "@opengeni/agent-proto";
import { NatsControlRpc, subjectFor } from "@opengeni/runtime/sandbox";

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
    if (!live?.connectionInstanceId || !live.agentVersion) {
      throw new HTTPException(409, {
        message: "machine has no authoritative live agent build",
      });
    }
    const channel = live.agentUpdateChannel ?? "stable";
    const targetVersion =
      channel === "beta"
        ? (settings.agentBetaVersion ?? settings.agentStableVersion)
        : settings.agentStableVersion;
    const reusableRequest =
      live.agentUpdate?.status === "requested" &&
      live.agentUpdate.targetVersion === targetVersion &&
      live.agentUpdate.connectionInstanceId === live.connectionInstanceId &&
      live.agentUpdate.connectionGeneration === live.connectionGeneration
        ? live.agentUpdate
        : null;
    if (
      !reusableRequest &&
      live.agentVersion === targetVersion &&
      live.agentUpdate?.status !== "failed"
    ) {
      throw new HTTPException(409, {
        message: "machine already runs the promoted version",
      });
    }
    const operationId = reusableRequest?.operationId ?? crypto.randomUUID();
    if (!reusableRequest) {
      const reserved = await beginEnrollmentAgentUpdate(db, {
        accountId: grant.accountId,
        workspaceId: originWorkspaceId,
        enrollmentId,
        connectionInstanceId: live.connectionInstanceId,
        connectionGeneration: live.connectionGeneration,
        operationId,
        targetVersion,
      });
      if (!reserved) {
        throw new HTTPException(409, {
          message: "machine update state changed; refresh and retry",
        });
      }
    }

    const rpc = new NatsControlRpc(async () => bus?.getRequestConnection() ?? null);
    const request: ControlRequest = {
      requestId: operationId,
      // The subject already selects the exact authoritative process instance.
      // `epoch` is the sandbox lease epoch, not the enrollment connection
      // generation, so this process-scoped operation intentionally leaves it 0.
      epoch: 0,
      resourcePolicy: undefined,
      op: {
        $case: "agentUpdateApply",
        agentUpdateApply: {
          operationId,
          targetVersion,
          channel,
          expectedCurrentVersion: live.agentVersion,
          expectedCurrentSha256: live.agentBinarySha256 ?? "",
          releaseBaseUrl: (settings.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, ""),
        },
      },
    };
    let response = await rpc.request(
      subjectFor(originWorkspaceId, enrollmentId, live.connectionInstanceId),
      request,
      { timeoutMs: 10_000 },
    );
    // The operation id is idempotent. One retry heals an ambiguous lost reply;
    // the agent returns the same acceptance and never starts a second update.
    if (response.error?.code === ErrorCode.ERROR_CODE_TIMEOUT) {
      response = await rpc.request(
        subjectFor(originWorkspaceId, enrollmentId, live.connectionInstanceId),
        request,
        { timeoutMs: 10_000 },
      );
    }
    if (response.error) {
      // A second timeout remains ambiguous: progress/Hello may still prove the
      // operation. Keep it requested rather than racing a false terminal failure.
      if (response.error.code !== ErrorCode.ERROR_CODE_TIMEOUT) {
        await advanceEnrollmentAgentUpdate(db, {
          accountId: grant.accountId,
          workspaceId: originWorkspaceId,
          enrollmentId,
          connectionInstanceId: live.connectionInstanceId,
          connectionGeneration: live.connectionGeneration,
          operationId,
          status: "failed",
          errorCode:
            response.error.detail.failure_code ??
            (response.error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE
              ? "agent_offline"
              : "update_dispatch_rejected"),
          retryable: response.error.retryable,
          rolledBack: false,
        });
        throw new HTTPException(response.error.retryable ? 409 : 422, {
          message: response.error.message,
        });
      }
    } else if (
      response.result?.$case !== "agentUpdateApply" ||
      !response.result.agentUpdateApply.accepted
    ) {
      await advanceEnrollmentAgentUpdate(db, {
        accountId: grant.accountId,
        workspaceId: originWorkspaceId,
        enrollmentId,
        connectionInstanceId: live.connectionInstanceId,
        connectionGeneration: live.connectionGeneration,
        operationId,
        status: "failed",
        errorCode: "invalid_agent_response",
        retryable: true,
        rolledBack: false,
      });
      throw new HTTPException(502, {
        message: "agent returned an invalid update response",
      });
    } else {
      await advanceEnrollmentAgentUpdate(db, {
        accountId: grant.accountId,
        workspaceId: originWorkspaceId,
        enrollmentId,
        connectionInstanceId: live.connectionInstanceId,
        connectionGeneration: live.connectionGeneration,
        operationId,
        status: "accepted",
      });
    }
    return c.json(
      UpdateMachineAgentResponse.parse({
        operationId,
        accepted: true,
        targetVersion,
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
    const body = SwapActiveSandboxRequest.parse(await c.req.json());
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
