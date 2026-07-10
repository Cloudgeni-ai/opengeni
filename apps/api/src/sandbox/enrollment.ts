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
  signEnrollToken,
  signRelayToken,
  verifyEnrollToken,
  type DeviceEnrollmentLookupResponse,
  type DeviceEnrollmentPollResponse,
  type DeviceEnrollmentStartResponse,
  type EnrollmentCredentialsResponse,
  type EnrollTokenExchangeResponse,
  type MintEnrollTokenResponse,
} from "@opengeni/contracts";
import {
  approveDeviceEnrollmentRequest,
  consumeDeviceEnrollmentRequest,
  createDeviceEnrollmentRequest,
  denyDeviceEnrollmentRequest,
  finalizeEnrollmentByToken,
  getDeviceEnrollmentRequestByDeviceCode,
  getEnrollment,
  getPendingDeviceEnrollmentRequestByUserCode,
  getPendingDeviceEnrollmentRequestByUserCodeGlobal,
  type Database,
  type DeviceEnrollmentRequestRecord,
  type EnrollmentOs,
} from "@opengeni/db";
import { relayDialBaseFromSettings } from "@opengeni/core";

// The device-flow timing knobs (RFC 8628). Short TTL + a poll interval the agent
// must honor (the route rate-limits to the same cadence). These mirror the proto's
// DeviceAuthStartResponse interval/expiry fields.
export const DEVICE_CODE_TTL_SECONDS = 600; // 10 minutes
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
// The bearer the agent presents to the NATS auth-callout. A bring-your-own-compute
// machine is PERSISTENT (unlike an ephemeral Modal box, whose lifetime ~= an agent
// token's hour), so this is long-lived — 30 days, matching the relay token below —
// and re-minted on every poll/re-enroll. The old 1-hour value (sized for a Modal
// box) caused a self-hosted agent to drop PERMANENTLY one hour after connecting: the
// bearer expired and the auth-callout rejected every reconnect ("re-enroll may be
// required"). A long-lived bearer is safe because the auth-callout RE-CHECKS the
// enrollment status on every (re)connect (auth-callout.ts) — a revoked machine is
// denied regardless of bearer life — exactly as the long-lived relay token relies on.
export const ENROLLMENT_BEARER_TTL_SECONDS = 30 * 24 * 3600;
// The relay PRODUCER token (the `ogr_` token; M8b/dossier §10.5) is ENROLLMENT-scoped,
// NOT per-stream: the agent presents it on every channel registration for the life
// of its run, and the producer side has no per-viewer epoch fence (that is the
// VIEWER's `ogs_` token's job). So it is long-lived — 30 days — re-minted on every
// poll/re-enroll. The relay re-verifies it (authenticity + the channel-key ws+agent
// scope) on every StreamOpen; a revoked enrollment's machine goes offline at the
// control plane regardless, so a long-lived relay token cannot reach a dead agent.
export const RELAY_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
// The headless enroll token (`oget_`; design 11 §A2.1) TTL. 1h: long enough to
// script a fleet rollout, short enough to bound exposure of a workspace-scoped
// secret that IS the grant (no human approve). Re-mintable by an authorized user.
export const ENROLL_TOKEN_TTL_SECONDS = 3600;

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
  // Public web origin where the user goes to approve (may differ from the API).
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

  const base = input.verificationOrigin.replace(/\/+$/, "");
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
  const pending = await getPendingDeviceEnrollmentRequestByUserCode(
    db,
    input.workspaceId,
    input.userCode,
  );
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

/** LOOK UP a pending flow by user_code GLOBALLY (the click-Grant approve page;
 *  design 11 §B.1). Returns the resolved pending record (carrying its workspaceId)
 *  or null when no live pending row matches the code. The ROUTE authorizes the
 *  caller against the resolved workspaceId (enrollments:read) BEFORE exposing
 *  anything — a failed grant OR a null here both surface as 404 so cross-workspace
 *  existence is never revealed. This does NOT consume the request. */
export async function lookupDeviceEnrollment(
  services: EnrollmentServices,
  input: { userCode: string },
): Promise<DeviceEnrollmentRequestRecord | null> {
  const { db } = services;
  return await getPendingDeviceEnrollmentRequestByUserCodeGlobal(db, input.userCode);
}

/** Project a resolved pending record to the presentational lookup response (no
 *  secrets, no device_code) the approve screen (EnrollmentConsent) renders. */
export function toLookupResponse(
  record: DeviceEnrollmentRequestRecord,
): DeviceEnrollmentLookupResponse {
  return {
    workspaceId: record.workspaceId,
    userCode: record.userCode,
    machine: {
      machineName: record.machineName,
      os: record.os,
      arch: record.arch,
      canOfferDisplay: record.canOfferDisplay,
      requestsScreenControl: record.requestsScreenControl,
    },
    expiresAt: record.expiresAt,
  };
}

/** DENY a flow by user_code (the explicit "no" at the approve page; design 11
 *  §B.2). Workspace-scoped (the route asserts the grant). Returns whether a pending
 *  row was flipped to denied (false for an unknown / already-terminal code). */
export async function denyDeviceEnrollment(
  services: EnrollmentServices,
  input: { accountId: string; workspaceId: string; userCode: string },
): Promise<{ denied: boolean }> {
  const { db } = services;
  const pending = await getPendingDeviceEnrollmentRequestByUserCode(
    db,
    input.workspaceId,
    input.userCode,
  );
  if (!pending) {
    return { denied: false };
  }
  return await denyDeviceEnrollmentRequest(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    requestId: pending.id,
  });
}

/** MINT a headless enroll token (design 11 §A2.2). Signs an `oget_` token bound to
 *  the workspace + account + the screen-control consent, with a 1h TTL. Returns
 *  null when the credential plane is disabled (no signing secret) so the route can
 *  mirror poll's "disabled" handling. The token value is NEVER logged. */
export async function mintEnrollToken(
  services: EnrollmentServices,
  input: { accountId: string; workspaceId: string; allowScreenControl: boolean },
): Promise<MintEnrollTokenResponse | null> {
  const { settings } = services;
  const secret = resolveEnrollmentSigningSecret(settings);
  if (!secret) {
    return null;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = nowSeconds + ENROLL_TOKEN_TTL_SECONDS;
  const token = await signEnrollToken(secret, {
    typ: "enroll",
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    allowScreenControl: input.allowScreenControl,
    iat: nowSeconds,
    exp,
  });
  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    expiresInSeconds: ENROLL_TOKEN_TTL_SECONDS,
  };
}

/** Distinguishes the two exchange failure modes for the route. */
export type ExchangeEnrollTokenResult =
  | { ok: true; credentials: EnrollTokenExchangeResponse["credentials"] }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "invalid" };

/** EXCHANGE a headless enroll token (design 11 §A2.3) — the UNAUTHENTICATED path
 *  where the token IS the auth. Verifies the `oget_` token, then performs the SAME
 *  finalize as approve (upsert enrollment + ensure selfhosted sandbox,
 *  consentedWholeMachine=true, consentedScreenControl=token.allowScreenControl) and
 *  builds the IDENTICAL EnrollmentCredentials the poll authorized branch returns.
 *  Returns reason "disabled" when no signing secret (mirror poll), "invalid" when
 *  the token fails verification (the route 401s). */
export async function exchangeEnrollToken(
  services: EnrollmentServices,
  input: {
    token: string;
    publicKey: string;
    os: EnrollmentOs;
    arch: string;
    machineName?: string | null;
    canOfferDisplay: boolean;
  },
): Promise<ExchangeEnrollTokenResult> {
  const { db, settings } = services;
  const secret = resolveEnrollmentSigningSecret(settings);
  if (!secret) {
    // The credential plane is off for this deployment — surface disabled, never a
    // 500, never an unsigned credential (mirror poll's disabled handling).
    return { ok: false, reason: "disabled" };
  }
  const claims = await verifyEnrollToken(secret, input.token);
  if (!claims) {
    // Bad prefix / signature / typ / expired — the token is not a valid grant.
    return { ok: false, reason: "invalid" };
  }

  // The SAME finalize as approve, but driven by the token's claims (no pending row).
  const sandboxName = (input.machineName?.trim() || `${input.os} machine`).slice(0, 256);
  const { enrollment } = await finalizeEnrollmentByToken(db, {
    accountId: claims.accountId,
    workspaceId: claims.workspaceId,
    pubkey: input.publicKey,
    hasDisplay: input.canOfferDisplay,
    // The token's allowScreenControl is the AUTHORITATIVE consent (NOT the agent's
    // requestsScreenControl) — it was baked in at mint by the authorizing user.
    allowScreenControl: claims.allowScreenControl,
    os: input.os,
    arch: input.arch,
    sandboxName,
  });

  const credentials = await buildEnrollmentCredentials(services, {
    secret,
    workspaceId: claims.workspaceId,
    agentId: enrollment.id,
    consentedScreenControl: enrollment.allowScreenControl,
  });
  return { ok: true, credentials };
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
 *  the Account-scoped subject prefix + the connect info. The bearer-as-NATS-token
 *  model (M-AUTH) closes the M5 placeholder: the agent presents the bearer as the
 *  connect AUTH TOKEN, nats-server's auth-callout responder validates it and mints a
 *  workspace-scoped user JWT, so there is NO per-machine NATS creds file to ship.
 *  `natsAccountCreds` is therefore vestigial — kept (proto-additive) and set to the
 *  bearer so an agent using it as the connect-token credential works uniformly. */
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
    // Hand the agent the canonical `/stream` dial base, NOT the raw configured URL.
    // The agent's relay producer appends only its routing query and assumes the base
    // already carries the relay's `/stream` route; a path-less base 400s the dial and
    // makes the terminal/desktop streams unreachable (dossier §V5/§V6).
    relayUrl: relayDialBaseFromSettings(settings),
    relayToken,
    // M-AUTH closes the placeholder: there is NO per-machine NATS Account creds
    // file. The agent presents the BEARER as the NATS connect auth-token; the
    // server's auth-callout responder validates it and mints a workspace-scoped
    // user JWT. We echo the bearer here so a consumer reading this (vestigial) field
    // as the connect credential still works — the value IS the bearer.
    natsAccountCreds: bearer,
    updatePublicKey: settings.agentUpdatePublicKey ?? "",
    consentedWholeMachine: true,
    consentedScreenControl: input.consentedScreenControl,
  };
}
