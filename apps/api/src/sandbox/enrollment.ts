// apps/api/src/sandbox/enrollment.ts — the API-DIRECT enrollment device-flow seam
// (M5 of the bring-your-own-compute mega-PR; dossier §10.2 enrollment + §18 LOUD
// consent). This is the service layer the routes (routes/enrollments.ts) call — it
// mirrors the channel-a.ts / viewer.ts split (a thin route over a focused service).
//
// THE FLOW (OAuth 2.0 device-authorization, RFC 8628):
//   1. start  (agent-side, user-unauthenticated, rate-limited): the agent presents
//      its ed25519 pubkey + os/arch + requested whole-machine exposure +
//      can-offer-display + requests-screen-control. We mint an unguessable
//      device_code (the poll key) + a short user_code (the user types) and persist a
//      short-TTL, SINGLE-USE pending row. Returns DeviceAuthStart.
//   2. approve (USER-authenticated, workspace-gated): the LOUD CONSENT step. We
//      record WHO consented WHEN to WHAT (whole-machine mandatory + screen-control
//      per allow_screen_control) and, in one txn, createEnrollment + createSandbox
//      (an enrollments row AND a sandboxes row appear — acceptance #2). Idempotent
//      via the M2 upsert.
//   3. poll   (agent-side, with device_code): pending → {pending}; approved → the
//      EnrollmentCredentials (agent_id + workspace + a SIGNED bearer the agent
//      presents to the control plane + the subject prefix agent.<ws>.<id> + a
//      placeholder for the per-workspace NATS Account creds [infra-deferred]);
//      denied/expired/disabled → the typed state.
//
// SECURITY (dossier §18): device_code/user_code are CSPRNG-unguessable + short-TTL +
// single-use; approve is strictly workspace-gated (the route asserts the grant); the
// signing secret value is NEVER logged. Rate-limiting of start/poll is enforced at
// the route. The consent record (who/when/what) lives on the request row.
//
// FLAG GATE: the whole feature is behind sandboxSelfhostedEnabled (default OFF) —
// when off the routes 404 (the surface is invisible) and boot is unaffected.

import { randomBytes } from "node:crypto";
import {
  resolveEnrollmentSigningSecret,
  resolveRelayTokenSecret,
  type Settings,
} from "@opengeni/config";
import {
  DeviceEnrollmentState,
  signEnrollmentBearer,
  signRelayToken,
  type DeviceEnrollmentPollResponse,
  type DeviceEnrollmentStartResponse,
  type EnrollmentCredentialsResponse,
} from "@opengeni/contracts";
import {
  approveDeviceEnrollmentRequest,
  consumeDeviceEnrollmentRequest,
  createDeviceEnrollmentRequest,
  getDeviceEnrollmentRequestByDeviceCode,
  getEnrollment,
  getPendingDeviceEnrollmentRequestByUserCode,
  type Database,
  type DeviceEnrollmentRequestRecord,
  type EnrollmentOs,
} from "@opengeni/db";

// The device-flow timing knobs (RFC 8628). Short TTL + a poll interval the agent
// must honor (the route rate-limits to the same cadence). These mirror the proto's
// DeviceAuthStartResponse interval/expiry fields.
export const DEVICE_CODE_TTL_SECONDS = 600; // 10 minutes
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
// The bearer the agent presents to the control plane is valid for the same horizon
// as an agent token's hour-long life (dossier "Agent token lifecycle"): 1 hour.
export const ENROLLMENT_BEARER_TTL_SECONDS = 3600;
// The relay PRODUCER token (the `ogr_` token; M8b/dossier §10.5) is ENROLLMENT-scoped,
// NOT per-stream: the agent presents it on every channel registration for the life
// of its run, and the producer side has no per-viewer epoch fence (that is the
// VIEWER's `ogs_` token's job). So it is long-lived — 30 days — re-minted on every
// poll/re-enroll. The relay re-verifies it (authenticity + the channel-key ws+agent
// scope) on every StreamOpen; a revoked enrollment's machine goes offline at the
// control plane regardless, so a long-lived relay token cannot reach a dead agent.
export const RELAY_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

export type EnrollmentServices = {
  db: Database;
  settings: Settings;
};

/** A workspace-scoped flow START context (the route resolves the workspace the
 *  agent's flow binds to from the deployment edge / a workspace hint). */
export type DeviceStartInput = {
  accountId: string;
  workspaceId: string;
  publicKey: string;
  os: EnrollmentOs;
  arch: string;
  machineName?: string | null;
  canOfferDisplay: boolean;
  requestsScreenControl: boolean;
  // Where the user goes to approve (same origin as the request).
  verificationOrigin: string;
};

// A CSPRNG opaque token (URL-safe base64, no padding) for the device_code. 32
// bytes = 256 bits of entropy — unguessable.
function mintDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

// A short, human-typeable user_code: 8 chars from an unambiguous alphabet (no
// 0/O/1/I), grouped XXXX-XXXX. CSPRNG-drawn (rejection-free via modulo over a
// 32-char alphabet, which divides 256 evenly enough; we draw extra bytes and map).
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars
function mintUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/**
 * START a device-flow: persist a short-TTL single-use pending request + return the
 * DeviceAuthStart. Retries the user_code mint on the (astronomically rare) partial-
 * unique collision among live pending rows.
 */
export async function startDeviceEnrollment(
  services: EnrollmentServices,
  input: DeviceStartInput,
): Promise<DeviceEnrollmentStartResponse> {
  const { db } = services;
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

  let request: DeviceEnrollmentRequestRecord | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5 && !request; attempt += 1) {
    const deviceCode = mintDeviceCode();
    const userCode = mintUserCode();
    try {
      request = await createDeviceEnrollmentRequest(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        deviceCode,
        userCode,
        pubkey: input.publicKey,
        os: input.os,
        arch: input.arch,
        machineName: input.machineName ?? null,
        requestedExposure: "whole-machine",
        canOfferDisplay: input.canOfferDisplay,
        requestsScreenControl: input.requestsScreenControl,
        expiresAt,
      });
    } catch (error) {
      // A unique-violation on the live user_code (or device_code) → re-mint + retry.
      lastError = error;
    }
  }
  if (!request) {
    throw lastError instanceof Error ? lastError : new Error("failed to start device enrollment");
  }

  const base = input.verificationOrigin.replace(/\/$/, "");
  const verificationUri = `${base}/device`;
  const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(request.userCode)}`;
  return {
    deviceCode: request.deviceCode,
    userCode: request.userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    expiresInSeconds: DEVICE_CODE_TTL_SECONDS,
  };
}

/** APPROVE a flow by user_code (the LOUD consent step). Returns the resulting
 *  enrollment + sandbox ids, or null when no LIVE pending request matches the code
 *  in this workspace (an unknown/expired/already-terminal code). */
export async function approveDeviceEnrollment(
  services: EnrollmentServices,
  input: {
    accountId: string;
    workspaceId: string;
    userCode: string;
    allowScreenControl: boolean;
    approvedBySubjectId: string;
    approvedBySubjectLabel?: string | null;
  },
): Promise<{ enrollmentId: string; sandboxId: string; allowScreenControl: boolean } | null> {
  const { db } = services;
  const pending = await getPendingDeviceEnrollmentRequestByUserCode(db, input.workspaceId, input.userCode);
  if (!pending) {
    return null;
  }
  // A generated, human-readable sandbox name (the machine name, or a fallback).
  const sandboxName = (pending.machineName?.trim() || `${pending.os} machine`).slice(0, 256);
  const result = await approveDeviceEnrollmentRequest(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    requestId: pending.id,
    allowScreenControl: input.allowScreenControl,
    approvedBySubjectId: input.approvedBySubjectId,
    approvedBySubjectLabel: input.approvedBySubjectLabel ?? null,
    sandboxName,
  });
  if (!result.approved || !result.enrollment || !result.sandbox) {
    return null;
  }
  return {
    enrollmentId: result.enrollment.id,
    sandboxId: result.sandbox.id,
    allowScreenControl: result.enrollment.allowScreenControl,
  };
}

/**
 * POLL a flow by device_code. Resolves the state machine:
 *   - unknown code              → "expired" (do not leak existence; an unknown code
 *                                  behaves like an expired one to the agent).
 *   - pending + within TTL      → "pending".
 *   - pending + past TTL        → "expired".
 *   - denied                    → "denied".
 *   - approved | consumed       → "authorized" + the EnrollmentCredentials (the
 *                                  approved row is flipped to consumed; a legitimate
 *                                  re-poll of a consumed row still returns the creds).
 * When the credential plane is disabled (no resolvable signing secret), an
 * otherwise-authorized poll returns "disabled" so the agent surfaces a clear reason
 * rather than half-enrolling.
 */
export async function pollDeviceEnrollment(
  services: EnrollmentServices,
  input: { deviceCode: string },
): Promise<DeviceEnrollmentPollResponse> {
  const { db, settings } = services;
  const request = await getDeviceEnrollmentRequestByDeviceCode(db, input.deviceCode);
  if (!request) {
    return { state: "expired" };
  }
  if (request.status === "denied") {
    return { state: "denied" };
  }
  if (request.status === "pending") {
    if (new Date(request.expiresAt).getTime() <= Date.now()) {
      return { state: "expired" };
    }
    return { state: "pending" };
  }

  // approved | consumed → AUTHORIZED. Build the credentials.
  if (!request.enrollmentId) {
    // Defensive: an approved row must carry the enrollment id.
    return { state: "expired" };
  }
  const secret = resolveEnrollmentSigningSecret(settings);
  if (!secret) {
    // The credential plane is off for this deployment (no signing secret) — surface
    // a clear disabled state, never a 500 and never an unsigned credential.
    return { state: "disabled" };
  }

  const enrollment = await getEnrollment(db, request.workspaceId, request.enrollmentId);
  if (!enrollment || enrollment.status !== "active") {
    // The machine was revoked between approve and poll — treat as denied.
    return { state: "denied" };
  }

  const credentials = await buildEnrollmentCredentials(services, {
    secret,
    workspaceId: request.workspaceId,
    agentId: enrollment.id,
    consentedScreenControl: enrollment.allowScreenControl,
  });

  // Single-use: flip approved → consumed (idempotent; a re-poll of an already-
  // consumed row still returns the creds above — the agent may legitimately retry).
  if (request.status === "approved") {
    await consumeDeviceEnrollmentRequest(db, {
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      requestId: request.id,
    });
  }

  return { state: DeviceEnrollmentState.enum.authorized, credentials };
}

/** Build the EnrollmentCredentials the poll returns: the signed `oge_` bearer +
 *  the Account-scoped subject prefix + the (possibly-empty) connect info. The real
 *  per-workspace NATS Account creds binding is INFRA-DEFERRED (M4/relay); we return
 *  a placeholder for that field and the bearer is the application-tier identity. */
async function buildEnrollmentCredentials(
  services: EnrollmentServices,
  input: { secret: string; workspaceId: string; agentId: string; consentedScreenControl: boolean },
): Promise<EnrollmentCredentialsResponse> {
  const { settings } = services;
  // The control-plane subject prefix the agent subscribes to: agent.<ws>.<id>.
  const subjectPrefix = `agent.${input.workspaceId}.${input.agentId}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = nowSeconds + ENROLLMENT_BEARER_TTL_SECONDS;
  const bearer = await signEnrollmentBearer(input.secret, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    enrollmentId: input.agentId,
    subjectPrefix,
    exp,
  });
  const natsUrls = settings.selfhostedNatsUrl ? [settings.selfhostedNatsUrl] : [];
  // Mint the agent's relay PRODUCER token (M8b) when the relay-token plane is
  // configured. The relay verifies it (the `ogr_` envelope) and pairs the producer
  // with the viewer. Absent secret → empty token (graceful degrade; the stream plane
  // is unavailable until the secret is provisioned via ops-repo IaC). The token binds
  // (workspaceId, agentId) so the agent can only register ITS OWN channels.
  const relayTokenSecret = resolveRelayTokenSecret(settings);
  const relayToken = relayTokenSecret
    ? await signRelayToken(relayTokenSecret, {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        exp: nowSeconds + RELAY_TOKEN_TTL_SECONDS,
      })
    : "";
  return {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    bearer,
    subjectPrefix,
    natsUrls,
    relayUrl: settings.selfhostedRelayUrl ?? "",
    relayToken,
    // INFRA-DEFERRED: the per-workspace NATS Account creds binding (M4/relay). Empty
    // until the Account-export config lands; the agent dials with the bearer +
    // subject prefix in the meantime.
    natsAccountCreds: "",
    updatePublicKey: settings.agentUpdatePublicKey ?? "",
    consentedWholeMachine: true,
    consentedScreenControl: input.consentedScreenControl,
  };
}
