// apps/api/src/sandbox/auth-callout.ts — the NATS AUTH-CALLOUT responder (the
// bring-your-own-compute M-AUTH tenancy boundary; dossier §10.1 NATS Accounts per
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
//   3. confirms the enrollment is still ACTIVE in the DB (a revoked machine is
//      denied even with a still-unexpired bearer);
//   4. signs a NATS user JWT granting pub/sub ONLY `agent.<ws>.>` + `_INBOX.>`
//      (deny-all-else by an allow-list) and returns it inside a signed
//      authorization-response JWT.
//
// That per-subject scope is the per-workspace ISOLATION: workspace A's agent is
// cryptographically incapable of pub/sub on `agent.B.>`. nats-server enforces the
// signed permission set; the boundary does not rely on subject naming alone (the M4
// transport test proved the CODE constructs scoped subjects; THIS proves the SERVER
// refuses cross-workspace access).
//
// SECURITY (§18): the bearer value + the account signing seed are NEVER logged. A
// validation failure → a DENIAL response (the server refuses the connection); a
// responder error → the request is left UNANSWERED (fail-closed; the server denies
// on its callout timeout). The bearer's `exp` caps the minted credential's life so a
// revoked/expired enrollment cannot outlive its bearer.

import { resolveEnrollmentSigningSecret, type NatsCalloutConfig, type Settings } from "@opengeni/config";
import { verifyEnrollmentBearer } from "@opengeni/contracts";
import { getEnrollment, type Database } from "@opengeni/db";
import {
  createResponderConnection,
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  workspaceAgentPermissions,
  type ResponderConnection,
} from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

/** The NATS subject nats-server publishes authorization requests on (ADR-26). */
export const AUTH_CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

export interface AuthCalloutDeps {
  db: Database;
  settings: Settings;
  callout: NatsCalloutConfig;
  observability?: Observability;
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
    deps.observability?.warn?.("auth-callout: rejected an invalid enrollment bearer", {});
    return deny("invalid or expired enrollment bearer");
  }

  // Confirm the enrollment is still ACTIVE — a revoked machine is denied even with a
  // still-unexpired bearer (the revoke path flips status; this re-checks at connect).
  const enrollment = await getEnrollment(deps.db, claims.workspaceId, claims.enrollmentId);
  if (!enrollment || enrollment.status !== "active") {
    deps.observability?.warn?.("auth-callout: denied a revoked or unknown enrollment", {
      workspaceId: claims.workspaceId,
      agentId: claims.agentId,
    });
    return deny("enrollment is not active");
  }

  // Belt-and-braces: the bearer's agentId/enrollmentId must match the row we found.
  // (verifyEnrollmentBearer already binds them; this guards a future schema where
  // agentId != enrollmentId.)
  if (enrollment.id !== claims.enrollmentId) {
    return deny("enrollment identity mismatch");
  }

  // GRANT: a user JWT scoped to ONLY this workspace's agent subtree + the reply
  // inbox. This allow-list IS the per-workspace isolation boundary.
  const permissions = workspaceAgentPermissions(claims.workspaceId);
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
    expiresAtSeconds: claims.exp,
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
    { name: "opengeni-auth-callout" },
  );
  deps.observability?.info?.("OpenGeni NATS auth-callout responder started", {
    subject: AUTH_CALLOUT_SUBJECT,
  });
  return connection;
}
