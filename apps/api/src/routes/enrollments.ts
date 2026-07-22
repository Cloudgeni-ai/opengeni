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
//     has no logged-in browser session). Their device-code credentials are checked
//     by the route/service itself; they are IP-rate-limited here and DO NOT call
//     requireAccessGrant. The deployment-key middleware admits these exact POSTs.
//   * device/approve + GET /enrollments + revoke are USER-authenticated +
//     workspace-gated via requireAccessGrant (enrollments:manage / enrollments:read;
//     workspace:admin is the super-wildcard).
//
// The cross-workspace safety of an unauthenticated start: start binds the request
// to a workspaceId the agent supplies, and ONLY a user holding a grant in THAT
// workspace can approve it (the approve's user_code lookup is workspace-scoped) — a
// start can never grant access to a workspace no authorized user later approves in.

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
  RevokeEnrollmentResponse,
  verifyEnrollmentBearer,
  type EnrollmentArch,
  type EnrollmentOs,
} from "@opengeni/contracts";
import {
  getWorkspace,
  listEnrollments,
  revokeEnrollment,
  revokeEnrollmentByGeneration,
} from "@opengeni/db";
import { resolveEnrollmentSigningSecret } from "@opengeni/config";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  approveDeviceEnrollment,
  denyDeviceEnrollment,
  exchangeEnrollToken,
  lookupDeviceEnrollment,
  mintEnrollToken,
  pollDeviceEnrollment,
  startDeviceEnrollment,
  toLookupResponse,
} from "../sandbox/enrollment";

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
  // acceptable for a bounded, access-key-gated, short-TTL flow.
  const startLimiter = new TokenBucket({ capacity: 10, refillPerSecond: 0.5 });
  const pollLimiter = new TokenBucket({ capacity: 60, refillPerSecond: 2 });
  // The click-Grant approve-page lookup (authenticated, but capped against a
  // user_code brute force — the lookup resolves a workspace from a short code).
  const lookupLimiter = new TokenBucket({ capacity: 30, refillPerSecond: 1 });
  // The headless token exchange (UNAUTHENTICATED — the token is the auth). Bounded
  // against an enroll-token brute force; the `oget_` HMAC is the real boundary.
  const exchangeLimiter = new TokenBucket({ capacity: 20, refillPerSecond: 0.5 });
  // The enrollment bearer is the complete credential for self-revocation. Keep
  // this route separately bounded because an attacker can submit arbitrary bearer
  // candidates without first holding a user or deployment credential.
  const selfRevokeLimiter = new TokenBucket({ capacity: 10, refillPerSecond: 0.25 });

  function rateLimit(c: Context, limiter: TokenBucket): void {
    const ip = clientIp(c);
    if (!limiter.take(ip)) {
      throw new HTTPException(429, { message: "too many requests; slow down" });
    }
  }

  // ── POST /enrollments/device/start (agent-side, user-unauthenticated) ───────
  app.post("/v1/enrollments/device/start", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, startLimiter);
    const parsed = DeviceEnrollmentStartRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid device-start request" });
    }
    const body = parsed.data;
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
        // The approval page is a public web route. In split API/UI deployments,
        // request origin may be an internal API host, so prefer the configured
        // public web origin and only derive from the request when it is absent.
        verificationOrigin:
          settings.publicBaseUrl?.replace(/\/+$/, "") ?? new URL(c.req.url).origin,
      },
    );
    return c.json(result, 201);
  });

  // ── POST /enrollments/device/poll (agent-side, user-unauthenticated) ────────
  app.post("/v1/enrollments/device/poll", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, pollLimiter);
    const parsed = DeviceEnrollmentPollRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid device-poll request" });
    }
    const result = await pollDeviceEnrollment(
      { db, settings },
      { deviceCode: parsed.data.deviceCode },
    );
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
    const parsed = DeviceEnrollmentLookupRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid device-lookup request" });
    }
    const record = await lookupDeviceEnrollment(
      { db, settings },
      { userCode: parsed.data.userCode },
    );
    if (!record) {
      // Unknown / terminal / expired code → 404 (indistinguishable from an
      // unauthorized one below, by design).
      throw new HTTPException(404, { message: "no pending enrollment for that code" });
    }
    // Authorize the caller against the RESOLVED workspace. A missing grant throws
    // 403/404 from requireAccessGrant; we normalize that to 404 so a caller cannot
    // distinguish "code exists in a workspace I can't see" from "no such code".
    try {
      await requireAccessGrant(c, deps, record.workspaceId, "enrollments:read");
    } catch {
      throw new HTTPException(404, { message: "no pending enrollment for that code" });
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
    const parsed = EnrollTokenExchangeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid enroll-token-exchange request" });
    }
    const body = parsed.data;
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
    if (!result.ok) {
      if (result.reason === "disabled") {
        // The credential plane is off for this deployment (no signing secret).
        throw new HTTPException(503, { message: "enrollment credential plane is not configured" });
      }
      // An invalid / expired / wrong-typ token — the token is the auth, so 401.
      throw new HTTPException(401, { message: "invalid or expired enroll token" });
    }
    return c.json(EnrollTokenExchangeResponse.parse({ credentials: result.credentials }), 201);
  });

  // ── POST /enrollments/self/revoke (ENROLLMENT-bearer authenticated) ───────
  // A machine can revoke only itself. The opaque `oge_` bearer is the complete
  // auth mechanism for this exact route; it is never logged or returned. We still
  // atomically lock/re-read the enrollment under the claims' workspace before
  // mutating so a forged, expired, cross-workspace, identity-mismatched, or stale-
  // generation bearer fails closed.
  // A matching *revoked* row is the one deliberate idempotency case: it returns
  // `{ revoked: false }` after a lost successful response. NATS auth-callout keeps
  // its stricter ACTIVE-only check, so that retry never restores machine access.
  app.post("/v1/enrollments/self/revoke", async (c) => {
    assertSelfhostedEnabled();
    rateLimit(c, selfRevokeLimiter);
    const authorization = c.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    const secret = resolveEnrollmentSigningSecret(settings);
    const claims = secret && bearer ? await verifyEnrollmentBearer(secret, bearer) : null;
    if (
      !claims ||
      claims.agentId !== claims.enrollmentId ||
      claims.subjectPrefix !== `agent.${claims.workspaceId}.${claims.agentId}`
    ) {
      throw new HTTPException(401, { message: "invalid or expired enrollment bearer" });
    }
    const result = await revokeEnrollmentByGeneration(db, {
      workspaceId: claims.workspaceId,
      enrollmentId: claims.enrollmentId,
      credentialGeneration: claims.credentialGeneration,
    });
    if (!result.matched) {
      throw new HTTPException(401, { message: "enrollment identity is not valid" });
    }
    // The DAO's row lock + generation fence makes a same-generation lost-response
    // retry deterministic (`revoked:false`) while an older generation is a 401.
    return c.json(RevokeEnrollmentResponse.parse({ revoked: result.revoked }));
  });

  // ── POST /workspaces/:workspaceId/enrollments/device/approve (user-authed) ──
  // The LOUD CONSENT step. requireAccessGrant BEFORE the Zod parse.
  app.post("/v1/workspaces/:workspaceId/enrollments/device/approve", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:manage");
    assertSelfhostedEnabled();
    const parsed = DeviceEnrollmentApproveRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid device-approve request" });
    }
    const body = parsed.data;
    const approved = await approveDeviceEnrollment(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        userCode: body.userCode,
        allowScreenControl: body.allowScreenControl,
        // The LOUD consent record: WHO consented (the authenticated subject + label).
        approvedBySubjectId: grant.subjectId,
        approvedBySubjectLabel: grant.subjectLabel ?? null,
      },
    );
    if (!approved) {
      // An unknown / expired / already-terminal user_code in this workspace.
      throw new HTTPException(404, { message: "no pending enrollment for that code" });
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
    const parsed = DeviceEnrollmentDenyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid device-deny request" });
    }
    const result = await denyDeviceEnrollment(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        userCode: parsed.data.userCode,
      },
    );
    return c.json(DeviceEnrollmentDenyResponse.parse({ denied: result.denied }), 200);
  });

  // ── POST /workspaces/:workspaceId/enrollments/token (user-authed) ───────────
  // Mint a short-TTL headless enroll token. Mirrors approve (enrollments:manage,
  // requireAccessGrant BEFORE the parse). The accountId comes from the grant. No
  // signing secret → 503/disabled (mirror poll). The token is SECRET — never logged.
  app.post("/v1/workspaces/:workspaceId/enrollments/token", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:manage");
    assertSelfhostedEnabled();
    // All fields are optional/defaulted, so an empty POST body is valid (default
    // allowScreenControl=false). Coalesce a missing/empty body to {} before parse.
    const parsed = MintEnrollTokenRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid mint-enroll-token request" });
    }
    const minted = await mintEnrollToken(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        allowScreenControl: parsed.data.allowScreenControl,
      },
    );
    if (!minted) {
      // The credential plane is off (no signing secret) — mirror poll's disabled path.
      throw new HTTPException(503, { message: "enrollment credential plane is not configured" });
    }
    return c.json(MintEnrollTokenResponse.parse(minted), 201);
  });

  // ── GET /workspaces/:workspaceId/enrollments (user-authed) ──────────────────
  app.get("/v1/workspaces/:workspaceId/enrollments", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "enrollments:read");
    assertSelfhostedEnabled();
    const statusFilter = c.req.query("status");
    const rows = await listEnrollments(
      db,
      workspaceId,
      statusFilter === "active" ? { status: "active" } : {},
    );
    return c.json(
      ListEnrollmentsResponse.parse({
        enrollments: rows.map((row) =>
          EnrollmentSummary.parse({
            id: row.id,
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "enrollments:manage");
    assertSelfhostedEnabled();
    const result = await revokeEnrollment(db, {
      accountId: grant.accountId,
      workspaceId,
      enrollmentId: c.req.param("enrollmentId"),
    });
    return c.json(RevokeEnrollmentResponse.parse(result));
  });
}

// The remote client IP for the per-IP rate-limit bucket. Honors the proxy's
// X-Forwarded-For (the first hop) when present, falling back to a constant key when
// neither is available (the bucket then caps the whole edge — still a useful cap).
function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip")?.trim() || "unknown";
}

// A minimal per-key token bucket. capacity = burst; refillPerSecond = sustained
// rate. Buckets are created lazily and reset their tokens by elapsed time on each
// take, so an idle key fully refills without a background timer.
class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: { capacity: number; refillPerSecond: number }) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
  }

  take(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = now;
    // Prune the map opportunistically so it never grows unbounded: a fully-refilled
    // bucket carries no state worth keeping.
    if (bucket.tokens >= this.capacity && this.buckets.size > 10_000) {
      this.buckets.delete(key);
    }
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}
