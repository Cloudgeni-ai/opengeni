// apps/api/src/sandbox/auth-callout.ts — the NATS AUTH-CALLOUT responder (the
// bring-your-own-compute M-AUTH tenancy boundary; NATS Accounts per
// workspace + §17 the isolation smoke + §19 the NATS-Accounts-misconfig leak risk).
//
// THE BOUNDARY THIS CLOSES: an external agent connects to NATS presenting its
// `oge_` enrollment bearer as the connect auth-token. nats-server (configured with
// `auth_callout`) issues an authorization request on $SYS.REQ.USER.AUTH. THIS
// responder:
//   1. decodes the authorization request (the `user_nkey` the response must scope
//      to, the `server_id` for the response `aud`, and the presented `auth_token`);
//   2. VALIDATES the bearer with verifyEnrollmentBearer (HMAC, via
//      resolveEnrollmentSigningSecret) — an invalid/expired/forged bearer is denied;
//   3. confirms the enrollment is still ACTIVE in the DB at the exact credential
//      generation (a revoked or re-enrolled machine denies an old bearer);
//   4. atomically claims the daemon instance named in CONNECT;
//   5. signs a NATS user JWT granting pub/sub ONLY that exact process subtree +
//      `_INBOX.>` (deny-all-else by an allow-list) and returns it inside a signed
//      authorization-response JWT.
//
// That exact scope is both the tenancy boundary and routing fence: workspace A
// cannot reach B, and an old/duplicate process cannot subscribe to its successor's
// work. nats-server enforces the signed permission set; the boundary does not rely
// on naming alone.
//
// SECURITY (§18): the bearer value + the account signing seed are NEVER logged. A
// validation failure → a DENIAL response (the server refuses the connection); a
// responder error → the request is left UNANSWERED (fail-closed; the server denies
// on its callout timeout). The bearer's `exp` caps the minted credential's life so a
// revoked/expired enrollment cannot outlive its bearer.

import { createHash } from "node:crypto";
import { createLogThrottle, type LogThrottle } from "@opengeni/observability";
import {
  resolveEnrollmentSigningSecret,
  type NatsCalloutConfig,
  type Settings,
} from "@opengeni/config";
import { verifyEnrollmentBearer } from "@opengeni/contracts";
import { claimEnrollmentConnection, getEnrollment, type Database } from "@opengeni/db";
import {
  createResponderConnection,
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  parseAgentConnectionName,
  workspaceAgentPermissions,
  type ResponderConnection,
} from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { observabilityEventLogger } from "../observability";
import { AGENT_CONNECTION_LEASE_MS } from "./connection-authority";

/** The NATS subject nats-server publishes authorization requests on (ADR-26). */
export const AUTH_CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";
/** Keep live NATS credentials short-lived while never outliving the bearer. */
export const NATS_USER_JWT_TTL_SECONDS = 5 * 60;
export interface AuthCalloutDeps {
  db: Database;
  settings: Settings;
  callout: NatsCalloutConfig;
  observability?: Observability;
  /** Bounds repeated denial warnings; defaults to one process-wide throttle. */
  denialWarningThrottle?: LogThrottle;
}

/** A stale or revoked machine re-dials on its reconnect backoff forever, so an
 * unthrottled denial warning repeats every few seconds per machine. Log each
 * distinct machine's first denial, then at most once per interval with the
 * count of denials it hid. The denial decision itself is never throttled. */
export const AUTH_CALLOUT_DENIAL_WARNING_INTERVAL_MS = 60_000;
const processDenialWarningThrottle = createLogThrottle({
  intervalMs: AUTH_CALLOUT_DENIAL_WARNING_INTERVAL_MS,
  maxKeys: 1_024,
});

/** Closed denial vocabulary. The public log projection drops identifiers, so
 * `reason` is what tells an operator which throttle key a count belongs to. */
type AuthCalloutDenialReason = "invalid_bearer" | "inactive_enrollment" | "duplicate_runner";

function warnDenial(
  deps: AuthCalloutDeps,
  key: string,
  reason: AuthCalloutDenialReason,
  message: string,
  attributes: Record<string, string | number> = {},
): void {
  const admission = (deps.denialWarningThrottle ?? processDenialWarningThrottle).admit(key);
  if (!admission) return;
  deps.observability?.warn?.(message, {
    ...attributes,
    reason,
    ...(admission.suppressedCount > 0 ? { suppressedCount: admission.suppressedCount } : {}),
  });
}

/** A process-local dedupe key for a rejected bearer. The digest is never
 * logged, and the bearer value never leaves this function. */
function rejectedBearerKey(bearer: string): string {
  return `invalid-bearer:${createHash("sha256").update(bearer).digest("hex").slice(0, 32)}`;
}

/**
 * The pure validate→scoped-JWT decision, isolated from the NATS transport so it is
 * unit-testable. Given the raw authorization-request JWT bytes, returns the signed
 * authorization-response JWT bytes to reply with — a GRANT (embedding a scoped user
 * JWT) on success, a DENIAL (carrying `nats.error`, no user JWT) otherwise. NEVER
 * throws on a bad/invalid request: every failure becomes a signed denial (the
 * server then refuses the connection cleanly).
 */
export async function handleAuthorizationRequest(
  deps: AuthCalloutDeps,
  requestBytes: Uint8Array,
): Promise<Uint8Array> {
  const requestJwt = Buffer.from(requestBytes).toString("utf8");
  const decoded = decodeAuthRequest(requestJwt);
  if (!decoded) {
    // A malformed request we cannot even read the user_nkey/server_id from — there
    // is nothing to scope a response to. Leave it for the server's timeout by
    // throwing (the transport leaves it unanswered, fail-closed).
    deps.observability?.warn?.("auth-callout: undecodable authorization request", {});
    throw new Error("undecodable authorization request");
  }

  const deny = (reason: string): Uint8Array => {
    // A SIGNED denial: the server reads `nats.error` and refuses the connection.
    const response = mintAuthResponse({
      userPublicKey: decoded.userNkey,
      serverId: decoded.serverId,
      accountSeed: deps.callout.accountSeed,
      error: reason,
    });
    return Buffer.from(response, "utf8");
  };

  const bearer = decoded.authToken;
  if (!bearer) {
    return deny("missing enrollment bearer");
  }

  const secret = resolveEnrollmentSigningSecret(deps.settings);
  if (!secret) {
    // The credential plane is off for this deployment — deny rather than mint an
    // unscoped credential. (The responder should not even be running in this case,
    // but fail-closed regardless.)
    return deny("enrollment credential plane disabled");
  }

  const claims = await verifyEnrollmentBearer(secret, bearer);
  if (!claims) {
    // Invalid signature / malformed / expired bearer. NEVER log the bearer value.
    warnDenial(
      deps,
      rejectedBearerKey(bearer),
      "invalid_bearer",
      "auth-callout: rejected an invalid enrollment bearer",
    );
    return deny("invalid or expired enrollment bearer");
  }

  // Confirm the enrollment is still ACTIVE — a revoked machine is denied even with a
  // still-unexpired bearer (the revoke path flips status; this re-checks at connect).
  const enrollment = await getEnrollment(deps.db, claims.workspaceId, claims.enrollmentId);
  if (!enrollment || enrollment.status !== "active") {
    warnDenial(
      deps,
      `inactive:${claims.workspaceId}:${claims.agentId}`,
      "inactive_enrollment",
      "auth-callout: denied a revoked or unknown enrollment",
      { workspaceId: claims.workspaceId, agentId: claims.agentId },
    );
    return deny("enrollment is not active");
  }

  // Belt-and-braces: the bearer's agentId/enrollmentId must match the row we found.
  // (verifyEnrollmentBearer already binds them; this guards a future schema where
  // agentId != enrollmentId.)
  if (
    enrollment.workspaceId !== claims.workspaceId ||
    enrollment.id !== claims.enrollmentId ||
    enrollment.id !== claims.agentId ||
    claims.agentId !== claims.enrollmentId ||
    claims.subjectPrefix !== `agent.${claims.workspaceId}.${claims.agentId}`
  ) {
    return deny("enrollment identity mismatch");
  }
  if (enrollment.credentialGeneration !== claims.credentialGeneration) {
    return deny("enrollment credential generation mismatch");
  }

  const connectionInstanceId = parseAgentConnectionName(decoded.name);
  if (!connectionInstanceId) {
    return deny("missing or invalid agent connection instance");
  }
  const claim = await claimEnrollmentConnection(deps.db, {
    workspaceId: claims.workspaceId,
    enrollmentId: claims.enrollmentId,
    credentialGeneration: claims.credentialGeneration,
    connectionInstanceId,
    leaseMs: AGENT_CONNECTION_LEASE_MS,
  });
  if (!claim.claimed) {
    warnDenial(
      deps,
      `duplicate:${claims.workspaceId}:${claims.agentId}`,
      "duplicate_runner",
      "auth-callout: denied a duplicate live runner",
      { workspaceId: claims.workspaceId, agentId: claims.agentId },
    );
    return deny("another runner instance currently owns this enrollment");
  }

  // GRANT: the operational subject includes the exact claimed process instance.
  // A previous socket may remain open until its short JWT expires, but no control
  // request is routed to its old subject after a successor claims authority.
  const permissions = workspaceAgentPermissions(
    claims.workspaceId,
    claims.agentId,
    connectionInstanceId,
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  const userJwt = mintUserJwt({
    userPublicKey: decoded.userNkey,
    accountSeed: deps.callout.accountSeed,
    name: claims.agentId,
    permissions,
    // Server-config-mode placement: the embedded user JWT's `aud` is the account
    // the user binds to (the configured `auth_callout.account`). All agents +
    // the privileged control plane share this account so subjects route; the
    // per-workspace isolation is carried by the subject permissions above.
    audienceAccount: deps.callout.accountName,
    // Tie the credential's life to the bearer's remaining life: a revoked/expired
    // enrollment cannot outlive its bearer at the NATS layer either.
    expiresAtSeconds: Math.min(claims.exp, nowSeconds + NATS_USER_JWT_TTL_SECONDS),
  });
  const response = mintAuthResponse({
    userPublicKey: decoded.userNkey,
    serverId: decoded.serverId,
    accountSeed: deps.callout.accountSeed,
    userJwt,
  });
  deps.observability?.info?.("auth-callout: granted a workspace-scoped NATS credential", {
    workspaceId: claims.workspaceId,
    agentId: claims.agentId,
    connectionGeneration: claim.connectionGeneration,
  });
  return Buffer.from(response, "utf8");
}

/**
 * Start the auth-callout responder: open a SEPARATE NATS connection authenticated
 * as the callout `auth_users` user, subscribe $SYS.REQ.USER.AUTH, and answer every
 * authorization request via {@link handleAuthorizationRequest}. Returns a handle
 * whose `close()` drains the connection. Gated by the caller (sandboxSelfhostedEnabled
 * + a resolvable callout config); a deployment without the callout plane never starts
 * it.
 */
export async function startAuthCalloutResponder(
  deps: AuthCalloutDeps,
  natsUrl: string,
): Promise<ResponderConnection> {
  const connection = await createResponderConnection(
    natsUrl,
    { kind: "user-password", user: deps.callout.user, pass: deps.callout.password },
    AUTH_CALLOUT_SUBJECT,
    (bytes) => handleAuthorizationRequest(deps, bytes),
    {
      name: "opengeni-auth-callout",
      ...(deps.observability ? { logger: observabilityEventLogger(deps.observability) } : {}),
    },
  );
  deps.observability?.info?.("OpenGeni NATS auth-callout responder started", {
    subject: AUTH_CALLOUT_SUBJECT,
  });
  return connection;
}
