// apps/api/src/routes/machines.ts — the M10 Machines-dashboard + per-machine
// metrics-series ROUTES (dossier §10.7). Mirrors registerEnrollmentRoutes: thin
// routes over a focused service (../sandbox/machines.ts), requireAccessGrant
// BEFORE any work, the whole router gated behind sandboxSelfhostedEnabled
// (default OFF → 404, invisible). Both routes need perm enrollments:read.
//
//   GET /v1/workspaces/:ws/machines[?sessionId=...]  -> MachinesResponse
//     The dashboard list: the workspace's enrolled selfhosted machines (state +
//     latest metrics + sharedSessionCount) and, when sessionId is supplied, the
//     session's synthetic Modal group box + the active-sandbox pointer.
//
//   GET /v1/workspaces/:ws/machines/:enrollmentId/metrics/series?window=1h
//     -> { samples: MetricSample[] }
//     The downsampled (~1/min) history for ONE machine over a time window.

import {
  MachineMetricsSeriesResponse,
  MachinesResponse,
  SwapActiveSandboxRequest,
  SwapActiveSandboxResponse,
} from "@opengeni/contracts";
import { getEnrollment, readMachineMetricsSeries } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildFleetContextForSession, swapActiveSandbox } from "@opengeni/core";
import { listMachines, metricRowToSample } from "../sandbox/machines";

// The supported series windows → milliseconds. An unknown/absent window defaults
// to 1h (the dossier default). Bounded so a caller cannot request an unbounded
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

  // ── GET /workspaces/:ws/machines (the dashboard list) ───────────────────────
  app.get("/v1/workspaces/:workspaceId/machines", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "enrollments:read");
    assertSelfhostedEnabled();
    // sessionId is OPTIONAL: present → an in-session view (synthetic group box +
    // active pointer); absent → the pure workspace dashboard.
    const sessionId = c.req.query("sessionId") ?? null;
    const response = await listMachines({ db, settings, bus }, { workspaceId, sessionId });
    return c.json(MachinesResponse.parse(response));
  });

  // ── GET /workspaces/:ws/machines/:enrollmentId/metrics/series ───────────────
  app.get("/v1/workspaces/:workspaceId/machines/:enrollmentId/metrics/series", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "enrollments:read");
    assertSelfhostedEnabled();
    const enrollmentId = c.req.param("enrollmentId");
    // Validate the machine belongs to this workspace (RLS already scopes the read,
    // but a clear 404 beats an empty series for an unknown/cross-workspace id).
    const enrollment = await getEnrollment(db, workspaceId, enrollmentId);
    if (!enrollment) {
      throw new HTTPException(404, { message: "machine not found in this workspace" });
    }
    const windowMs = SERIES_WINDOWS_MS[c.req.query("window") ?? ""] ?? DEFAULT_SERIES_WINDOW_MS;
    const since = new Date(Date.now() - windowMs);
    const rows = await readMachineMetricsSeries(db, { workspaceId, enrollmentId, since });
    return c.json(
      MachineMetricsSeriesResponse.parse({
        samples: rows.map(metricRowToSample),
      }),
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
    });
    const result = await swapActiveSandbox({ db, settings, bus }, ctx, body.target);
    return c.json(SwapActiveSandboxResponse.parse(result));
  });
}
