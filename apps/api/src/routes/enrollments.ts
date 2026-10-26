// apps/api/src/routes/enrollments.ts — the bring-your-own-compute enrollment
// device-flow routes (M5). Mirrors the other sandbox route
// modules (registerSessionRoutes / registerApiKeyRoutes): a thin route over a
// focused service (../sandbox/enrollment.ts), requireAccessGrant BEFORE any Zod
// parse on the USER-authenticated routes, explicit HTTPException(400) on a parse
// failure (never a raw ZodError → 500), and the whole router gated behind
// sandboxSelfhostedEnabled (default OFF → every route 404s, invisible).
//
// AUTH SEAM (the device-flow split):
//   * device/start + device/poll are AGENT-side — user-UNAUTHENTICATED (the agent
//     has no logged-in browser session; it presents only the deployment access key
//     the app.use("*", requireAccessKey) edge already enforces). They are
//     IP-rate-limited here. They DO NOT call requireAccessGrant.
//   * device/approve + GET /enrollments + revoke are USER-authenticated +
//     workspace-gated via requireAccessGrant (enrollments:manage / enrollments:read;
//     workspace:admin is the super-wildcard).
//
// The cross-workspace safety of an unauthenticated start: start binds the request
// to a workspaceId the agent supplies, and ONLY a user holding a grant in THAT
// workspace can approve it (the approve's user_code lookup is workspace-scoped) — a
// start can never grant access to a workspace no authorized user later approves in.

import { randomUUID } from "node:crypto";
import { resolveEnrollmentSigningSecret } from "@opengeni/config";
import {
  DeviceEnrollmentApproveRequest,
  DeviceEnrollmentApproveResponse,
  DeviceEnrollmentDenyRequest,
  DeviceEnrollmentDenyResponse,
  DeviceEnrollmentLookupRequest,
  DeviceEnrollmentLookupResponse,
  DeviceEnrollmentPollRequest,
  DeviceEnrollmentStartRequest,
  EnrollmentSummary,
  EnrollTokenExchangeRequest,
  EnrollTokenExchangeResponse,
  ListEnrollmentsResponse,
  MintEnrollTokenRequest,
  MintEnrollTokenResponse,
  RemoveEnrollmentRequest,
  RenewEnrollmentRequest,
  RevokeEnrollmentResponse,
  type EnrollmentArch,
  type EnrollmentOs,
} from "@opengeni/contracts";
import {
  getWorkspace,
  listEnrollments,
  MachineRemovalIdempotencyError,
  MachineRemovalRevisionConflictError,
  PersonalMachineConnectedElsewhereError,
  removeEnrollment,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trustedRequestSourceRateLimitKey } from "../http/request-source";
import { isPersonalConnectionOwnerPrincipal } from "../connection-ownership";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requirePermission,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  approveDeviceEnrollment,
  denyDeviceEnrollment,
  exchangeEnrollToken,
  lookupDeviceEnrollment,
  mintEnrollToken,
  pollDeviceEnrollment,
  startDeviceEnrollment,
  renewEnrollmentCredentials,
  toLookupResponse,
} from "../sandbox/enrollment";
import { parseRequestBody } from "../http/request-body";

const ENROLLMENT_OUTCOMES = new Set([
  "ok",
  "authorized",
  "expired",
  "denied",
  "disabled",
  "invalid",
  "used",
  "unauthorized",
]);

// A personal machine reconnects only from the workspace it was first connected
// from. The install script and the approval page show this message verbatim.
const PERSONAL_MACHINE_ELSEWHERE_MESSAGE =
  "this machine was first connected as a personal machine from another workspace; connect it again from that workspace";

/** Machine enrollment decisions that never surface as an HTTP error status. */
function recordEnrollment(deps: ApiRouteDeps, flow: string, outcome: string): void {
  try {
    deps.observability?.incrementCounter({
      name: "opengeni_machine_enrollment_total",
      help: "Connected Machine enrollment decisions by flow (device_start, device_poll, token_exchange, renew) and closed outcome.",
      labels: { flow, outcome: ENROLLMENT_OUTCOMES.has(outcome) ? outcome : "other" },
    });
  } catch {
    // Telemetry never changes the enrollment decision.
  }
}

export function registerEnrollmentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db } = deps;

  // The whole feature is behind sandboxSelfhostedEnabled. A 404 (not 403) keeps the
  // surface invisible while disabled — it does not exist for this deployment yet.
  function assertSelfhostedEnabled(): void {
    if (!settings.sandboxSelfhostedEnabled) {
      throw new HTTPException(404, {
        message: "selfhosted enrollment is not enabled for this deployment",
      });
    }
  }

  // A tiny in-process IP token-bucket for the UNAUTHENTICATED agent routes (start/
  // poll). The relay tier owns the heavy stream rate-limiting; this
  // is the application-tier abuse cap on the device-flow endpoints. Per-IP buckets
  // are pruned lazily. Not a distributed limiter (one replica per bucket) — that is
  // acceptable for a bounded, short-TTL flow. These routes are public even behind
  // the deployment key, because a machine never holds that key.
  const startLimiter = new TokenBucket({ capacity: 10, refillPerSecond: 0.5 });
  const pollLimiter = new TokenBucket({ capacity: 60, refillPerSecond: 2 });
  // The click-Grant approve-page lookup (authenticated, but capped against a
  // user_code brute force — the lookup resolves a workspace from a short code).
  const lookupLimiter = new TokenBucket({ capacity: 30, refillPerSecond: 1 });
  // The headless token exchange (UNAUTHENTICATED — the token is the auth). Bounded
  // against an enroll-token brute force; the `oget_` HMAC is the real boundary.
  const exchangeLimiter = new TokenBucket({
    capacity: 20,
    refillPerSecond: 0.5,
  });

  function rateLimit(c: Context, limiter: TokenBucket): void {
    const ip = trustedRequestSourceRateLimitKey(c, settings);
    if (!limiter.take(ip)) {
      throw new HTTPException(429, { message: "too many requests; slow down" });
    }
  }

  // Machine authentication: signed install-key proof + current enrollment grant.
  app.post("/v1/enrollments/renew", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, exchangeLimiter);
    const parsed = parseRequestBody(RenewEnrollmentRequest, await c.req.json().catch(() => null), {
      status: 400,
      message: "invalid renewal request",
    });
    c.header("Cache-Control", "no-store");
    const now = Math.floor(Date.now() / 1000);
    // These failures do not establish that the credential can never recover.
    if (Math.abs(now - parsed.signedAt) > 120)
      return c.json(
        {
          code: "enrollment_clock_skew",
          message: "Correct the machine clock, then retry credential renewal.",
        },
        401,
      );
    if (!resolveEnrollmentSigningSecret(settings))
      return c.json(
        {
          code: "enrollment_renewal_unavailable",
          message: "Credential renewal is temporarily unavailable.",
        },
        503,
      );
    const credentials = await renewEnrollmentCredentials({ db, settings }, parsed, now);
    recordEnrollment(deps, "renew", credentials ? "ok" : "unauthorized");
    if (!credentials)
      return c.json(
        {
          code: "enrollment_reconnect_required",
          message:
            "This connection can no longer renew its credentials. Connect this machine again, or remove the saved connection.",
        },
        401,
      );
    return c.json(EnrollTokenExchangeResponse.parse({ credentials }), 200);
  });

  // ── POST /enrollments/device/start (agent-side, user-unauthenticated) ───────
  app.post("/v1/enrollments/device/start", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, startLimiter);
    const parsed = parseRequestBody(
      DeviceEnrollmentStartRequest,
      await c.req.json().catch(() => null),
      { status: 400, message: "invalid device-start request" },
    );
    const body = parsed;
    // Resolve the (account) for the supplied workspace. An unknown workspace is a
    // 404 (the same shape requireAccessGrant uses for an unknown workspace).
    const workspace = await getWorkspace(db, body.workspaceId);
    if (!workspace) {
      throw new HTTPException(404, { message: "workspace not found" });
    }
    const result = await startDeviceEnrollment(
      { db, settings },
      {
        accountId: workspace.accountId,
        workspaceId: workspace.id,
        publicKey: body.publicKey,
        os: body.os as EnrollmentOs,
        arch: body.arch as EnrollmentArch,
        machineName: body.machineName ?? null,
        canOfferDisplay: body.canOfferDisplay,
        requestsScreenControl: body.requestsScreenControl,
        // Prefer the externally configured deployment origin. Behind a TLS-
        // terminating proxy c.req.url can carry the internal http scheme, which
        // must never leak into the device-flow command shown to the operator.
        verificationOrigin: settings.publicBaseUrl ?? new URL(c.req.url).origin,
      },
    );
    recordEnrollment(deps, "device_start", "ok");
    return c.json(result, 201);
  });

  // ── POST /enrollments/device/poll (agent-side, user-unauthenticated) ────────
  app.post("/v1/enrollments/device/poll", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, pollLimiter);
    const parsed = parseRequestBody(
      DeviceEnrollmentPollRequest,
      await c.req.json().catch(() => null),
      { status: 400, message: "invalid device-poll request" },
    );
    const result = await pollDeviceEnrollment({ db, settings }, { deviceCode: parsed.deviceCode });
    // `pending` is the normal polling loop; count only decisions.
    if (result.state !== "pending") recordEnrollment(deps, "device_poll", result.state);
    return c.json(result, 200);
  });

  // ── POST /enrollments/device/lookup (user-authed, NO workspace in path) ─────
  // The click-Grant approve page reads machine details for a user_code WITHOUT
  // consuming it. The user_code is globally unique among pending rows; we resolve
  // its workspace, then assert the caller holds enrollments:read in THAT workspace.
  // A failed grant OR no live pending row both → 404 (never reveal cross-workspace
  // existence). Rate-limited against a user_code brute force.
  app.post("/v1/enrollments/device/lookup", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, lookupLimiter);
    const parsed = parseRequestBody(
      DeviceEnrollmentLookupRequest,
      await c.req.json().catch(() => null),
      { status: 400, message: "invalid device-lookup request" },
    );
    const record = await lookupDeviceEnrollment({ db, settings }, { userCode: parsed.userCode });
    if (!record) {
      // Unknown / terminal / expired code → 404 (indistinguishable from an
      // unauthorized one below, by design).
      throw new HTTPException(404, {
        message: "no pending enrollment for that code",
      });
    }
    // Authorize the caller against the RESOLVED workspace. A missing grant throws
    // 403/404 from requireAccessGrant; we normalize that to 404 so a caller cannot
    // distinguish "code exists in a workspace I can't see" from "no such code".
    try {
      await requireAccessGrant(c, deps, record.workspaceId, "enrollments:read");
    } catch {
      throw new HTTPException(404, {
        message: "no pending enrollment for that code",
      });
    }
    return c.json(DeviceEnrollmentLookupResponse.parse(toLookupResponse(record)), 200);
  });

  // ── POST /enrollments/token/exchange (UNAUTHENTICATED — the token is the auth) ─
  // The headless / fleet enroll path. The agent presents the same identity fields
  // it sends to device/start plus the `oget_` enroll token. The token IS the grant
  // (no human approve). On a valid token we perform the SAME finalize as approve and
  // return the IDENTICAL EnrollmentCredentials shape the poll authorized branch
  // returns. Rate-limited against an enroll-token brute force.
  app.post("/v1/enrollments/token/exchange", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, exchangeLimiter);
    const parsed = parseRequestBody(
      EnrollTokenExchangeRequest,
      await c.req.json().catch(() => null),
      { status: 400, message: "invalid enroll-token-exchange request" },
    );
    const body = parsed;
    const result = await exchangeEnrollToken(
      { db, settings },
      {
        token: body.token,
        publicKey: body.publicKey,
        os: body.os as EnrollmentOs,
        arch: body.arch as EnrollmentArch,
        machineName: body.machineName ?? null,
        canOfferDisplay: body.canOfferDisplay,
      },
    );
    recordEnrollment(deps, "token_exchange", result.ok ? "ok" : result.reason);
    if (!result.ok) {
      if (result.reason === "disabled") {
        // The credential plane is off for this deployment (no signing secret).
        throw new HTTPException(503, {
          message: "enrollment credential plane is not configured",
        });
      }
      if (result.reason === "used") {
        // Single-use: another machine already redeemed this token. Same 401 as
        // an invalid token, with a message the install script prints verbatim.
        throw new HTTPException(401, {
          message:
            "this connect command was already used to connect another machine; create a new one for this machine",
        });
      }
      if (result.reason === "owner_unavailable") {
        // A personal command whose creator can no longer own a machine here.
        throw new HTTPException(403, {
          message:
            "the person who created this connect command can no longer connect machines to this workspace; create a new command",
        });
      }
      if (result.reason === "connected_elsewhere") {
        // Nothing changed and the command was not used up.
        throw new HTTPException(409, { message: PERSONAL_MACHINE_ELSEWHERE_MESSAGE });
      }
      if (result.reason === "busy") {
        throw new HTTPException(503, {
          message: "workspace membership is changing; run the connect command again",
        });
      }
      // An invalid / expired / wrong-typ token — the token is the auth, so 401.
      throw new HTTPException(401, {
        message: "invalid or expired enroll token",
      });
    }
    return c.json(EnrollTokenExchangeResponse.parse({ credentials: result.credentials }), 201);
  });

  // ── POST /workspaces/:workspaceId/enrollments/device/approve (user-authed) ──
  // The LOUD CONSENT step. requireAccessGrant BEFORE the Zod parse.
  app.post("/v1/workspaces/:workspaceId/enrollments/device/approve", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const grant = authorization.grant;
    requirePermission(grant, "enrollments:manage");
    assertSelfhostedEnabled();
    const rawBody = await c.req.json().catch(() => null);
    const body = parseRequestBody(DeviceEnrollmentApproveRequest, rawBody, {
      status: 400,
      message: "invalid device-approve request",
    });
    const scopeWasExplicit =
      typeof rawBody === "object" &&
      rawBody !== null &&
      Object.prototype.hasOwnProperty.call(rawBody, "scope");
    // Managed browser humans get the personal default. Legacy/delegated
    // principals predate organization-user ownership and retain the compatible
    // workspace default when the caller omitted scope; an explicit scope is
    // never silently rewritten.
    const effectiveScope =
      scopeWasExplicit ||
      (grant.principalKind === "human_session" &&
        authorization.contextIntegrity &&
        grant.metadata?.delegated !== true)
        ? body.scope
        : undefined;
    const allowOrganization =
      effectiveScope === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") === true;
    if (effectiveScope === "organization" && !allowOrganization) {
      throw new HTTPException(403, {
        message: "missing permission: account:admin",
      });
    }
    const approved = await approveDeviceEnrollment(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        ...(effectiveScope ? { scope: effectiveScope } : {}),
        allowOrganization,
        userCode: body.userCode,
        allowScreenControl: body.allowScreenControl,
        // The LOUD consent record: WHO consented (the authenticated subject + label).
        approvedBySubjectId: grant.subjectId,
        approvedBySubjectLabel: grant.subjectLabel ?? null,
      },
    ).catch((error: unknown) => {
      if (error instanceof PersonalMachineConnectedElsewhereError) {
        // Nothing changed; the request stays pending.
        throw new HTTPException(409, { message: PERSONAL_MACHINE_ELSEWHERE_MESSAGE });
      }
      throw error;
    });
    if (!approved) {
      // An unknown / expired / already-terminal user_code in this workspace.
      throw new HTTPException(404, {
        message: "no pending enrollment for that code",
      });
    }
    return c.json(
      DeviceEnrollmentApproveResponse.parse({
        approved: true,
        enrollmentId: approved.enrollmentId,
        sandboxId: approved.sandboxId,
        allowScreenControl: approved.allowScreenControl,
      }),
      201,
    );
  });

  // ── POST /workspaces/:workspaceId/enrollments/device/deny (user-authed) ─────
  // The explicit "no" at the approve page. Mirrors approve (enrollments:manage,
  // requireAccessGrant BEFORE the parse). Idempotent: a non-pending code → denied:false.
  app.post("/v1/workspaces/:workspaceId/enrollments/device/deny", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:manage");
    assertSelfhostedEnabled();
    const parsed = parseRequestBody(
      DeviceEnrollmentDenyRequest,
      await c.req.json().catch(() => null),
      { status: 400, message: "invalid device-deny request" },
    );
    const result = await denyDeviceEnrollment(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        userCode: parsed.userCode,
      },
    );
    return c.json(DeviceEnrollmentDenyResponse.parse({ denied: result.denied }), 200);
  });

  // ── POST /workspaces/:workspaceId/enrollments/token (user-authed) ───────────
  // Mint a short-TTL headless enroll token. Mirrors approve (enrollments:manage,
  // requireAccessGrant BEFORE the parse). The accountId comes from the grant. No
  // signing secret → 503/disabled (mirror poll). The token is SECRET — never logged.
  // `scope: "user"` signs the authenticated person as the machine's owner. Only a
  // verified person may ask for it: someone signed in, or a credential acting as
  // them (a personal API key, or an organization key or organization MCP client
  // acting as that person). A key, service or agent acting as itself gets 422.
  // The owner is always the caller, never a request field.
  app.post("/v1/workspaces/:workspaceId/enrollments/token", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    // The permission is part of the authorization, so a request that lacks it
    // is refused before any first-use workspace membership is provisioned.
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "enrollments:manage",
    );
    const grant = authorization.grant;
    assertSelfhostedEnabled();
    // All fields are optional/defaulted, so an empty POST body is valid (default
    // allowScreenControl=false). Coalesce a missing/empty body to {} before parse.
    const parsed = parseRequestBody(MintEnrollTokenRequest, await c.req.json().catch(() => ({})), {
      status: 400,
      message: "invalid mint-enroll-token request",
    });
    const personal = parsed.scope === "user";
    if (personal && !isPersonalConnectionOwnerPrincipal(authorization)) {
      throw new HTTPException(422, {
        message:
          "only a person, or a credential acting as that person, can connect a machine for themselves; keys, services and agents acting as themselves can connect workspace machines",
      });
    }
    const minted = await mintEnrollToken(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        allowScreenControl: parsed.allowScreenControl,
        ...(personal ? { ownerSubjectId: grant.subjectId } : {}),
      },
    );
    if (!minted) {
      // The credential plane is off (no signing secret) — mirror poll's disabled path.
      throw new HTTPException(503, {
        message: "enrollment credential plane is not configured",
      });
    }
    return c.json(MintEnrollTokenResponse.parse(minted), 201);
  });

  // ── GET /workspaces/:workspaceId/enrollments (user-authed) ──────────────────
  app.get("/v1/workspaces/:workspaceId/enrollments", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:read");
    assertSelfhostedEnabled();
    const statusFilter = c.req.query("status");
    if (statusFilter !== undefined && statusFilter !== "active" && statusFilter !== "revoked") {
      throw new HTTPException(400, {
        message: "status must be active or revoked",
      });
    }
    const rows = await listEnrollments(db, grant, {
      status: statusFilter === "revoked" ? "revoked" : "active",
    });
    return c.json(
      ListEnrollmentsResponse.parse({
        enrollments: rows.map((row) =>
          EnrollmentSummary.parse({
            id: row.id,
            scope: row.scope,
            generation: row.generation,
            pubkey: row.pubkey,
            exposure: row.exposure,
            hasDisplay: row.hasDisplay,
            desktopUnavailableReason: row.desktopUnavailableReason,
            allowScreenControl: row.allowScreenControl,
            status: row.status,
            os: row.os,
            arch: row.arch,
            lastSeenAt: row.lastSeenAt,
            createdAt: row.createdAt,
            revokedAt: row.revokedAt,
          }),
        ),
      }),
    );
  });

  // ── POST /workspaces/:workspaceId/enrollments/:id/revoke (user-authed) ──────
  app.post("/v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const grant = authorization.grant;
    requirePermission(grant, "enrollments:manage");
    assertSelfhostedEnabled();
    const parsed = parseRequestBody(RemoveEnrollmentRequest, await c.req.json().catch(() => ({})), {
      status: 400,
      message: "invalid machine removal request",
    });
    const idempotencyKey =
      parsed.idempotencyKey?.trim() || c.req.header("idempotency-key")?.trim() || randomUUID();
    try {
      const enrollmentId = c.req.param("enrollmentId");
      const enrollment = (await listEnrollments(db, grant, { status: "active" })).find(
        (candidate) => candidate.id === enrollmentId,
      );
      if (!enrollment) {
        throw new HTTPException(404, {
          message: "machine enrollment not found",
        });
      }
      if (
        enrollment.scope === "organization" &&
        authorization.accountGrant?.permissions.includes("account:admin") !== true
      ) {
        throw new HTTPException(403, {
          message: "missing permission: account:admin",
        });
      }
      const result = await removeEnrollment(db, {
        accountId: grant.accountId,
        workspaceId: enrollment.workspaceId,
        enrollmentId,
        operationKey: idempotencyKey,
        ...(parsed.expectedUpdatedAt ? { expectedUpdatedAt: parsed.expectedUpdatedAt } : {}),
        subjectId: grant.subjectId,
      });
      if (!result) {
        throw new HTTPException(404, {
          message: "machine enrollment not found",
        });
      }
      return c.json(
        RevokeEnrollmentResponse.parse({
          revoked: result.removed,
          ...result,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof MachineRemovalIdempotencyError) {
        throw new HTTPException(409, { message: error.message });
      }
      if (error instanceof MachineRemovalRevisionConflictError) {
        throw new HTTPException(409, {
          message: error.message,
          cause: {
            code: "stale_revision",
            currentUpdatedAt: error.currentUpdatedAt,
          },
        });
      }
      throw error;
    }
  });
}

// A minimal per-key token bucket. capacity = burst; refillPerSecond = sustained
// rate. Buckets are created lazily and reset their tokens by elapsed time on each
// take, so an idle key fully refills without a background timer.
// The map is bounded: a new key first drops buckets that have fully refilled
// (they carry no state), and if every tracked key is still active, the least
// recently used one.
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(options: { capacity: number; refillPerSecond: number; maxKeys?: number }) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Re-inserting keeps the map in least-recently-used order.
      this.buckets.delete(key);
    } else {
      this.makeRoom(now);
      bucket = { tokens: this.capacity, updatedAt: now };
    }
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  private makeRoom(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    // Under a flood of more than maxKeys distinct sources, evicting the least
    // recently used bucket resets that source's limit. That is acceptable: an
    // attacker who controls that many sources already has that aggregate rate.
    // At most one full sweep per second keeps a flood of new keys linear.
    if (now - this.lastSweepAt >= 1_000) {
      this.lastSweepAt = now;
      for (const [key, bucket] of this.buckets) {
        const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
        if (bucket.tokens + elapsedSeconds * this.refillPerSecond >= this.capacity) {
          this.buckets.delete(key);
        }
      }
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}
