import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ManagedAuthSessionSetMode,
  ManagedAuthSessionSetProjection,
} from "@opengeni/contracts/managed-auth-session-sets";
import {
  completeManagedAuthLoginTransaction,
  getManagedAuthSessionSetOperationReceipt,
  getManagedAuthSessionSetSnapshot,
  type Database,
  type ManagedAuthDatabaseProjection,
  type ManagedAuthSelectedSession,
} from "@opengeni/db";

export const MANAGED_AUTH_SESSION_SET_COOKIE = "opengeni.session_set" as const;
export const MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE = "opengeni.login_transaction" as const;
export const MANAGED_AUTH_CSRF_HEADER = "x-opengeni-session-csrf" as const;
export const MANAGED_AUTH_ACTOR_EPOCH_HEADER = "x-opengeni-actor-epoch" as const;
export const MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE_PATH =
  "/v1/auth/session-set/transactions" as const;

export type ManagedAuthResolvedSession = {
  session: { id: string; userId: string; [key: string]: unknown };
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    [key: string]: unknown;
  };
};

/** Provider-neutral boundary; provider credentials and tokens never cross its output. */
export interface ManagedAuthSessionAdapter {
  authenticate(input: {
    provider: "email_password";
    transactionId: string;
    credentials: { email: string; password: string };
    headers: Headers;
  }): Promise<{ authSessionId: string }>;
  /** Verify an ambient provider cookie without sliding expiry or emitting cookies. */
  resolveAmbientSession(headers: Headers): Promise<ManagedAuthResolvedSession | null>;
  resolveSelectedSession(
    input: ManagedAuthSelectedSession,
  ): Promise<ManagedAuthResolvedSession | null>;
  refreshSelectedSession(
    input: ManagedAuthSelectedSession,
  ): Promise<ManagedAuthResolvedSession | null>;
  revokeSession(input: { authSessionId: string }): Promise<void>;
  /** Dual-mode exact selected-session cookie plus stale provider-cache invalidations. */
  createLegacySelectedSessionCookies(
    input: ManagedAuthSelectedSession | null,
    currentCookieHeader?: string | null,
  ): Promise<string[]>;
}

export class ManagedAuthActorChangeError extends Error {
  readonly name = "ManagedAuthActorChangeError";
  readonly code = "actor_change_required";
  constructor() {
    super("The selected browser actor changed");
  }
}

export class ManagedAuthRequestAdmissionError extends Error {
  readonly name = "ManagedAuthRequestAdmissionError";
  readonly code = "origin_rejected";
}

export class ManagedAuthCompletionOutcomeUnknownError extends Error {
  readonly name = "ManagedAuthCompletionOutcomeUnknownError";
  readonly code = "operation_outcome_unknown";
  constructor(options?: ErrorOptions) {
    super("The managed authentication completion outcome is unknown", options);
  }
}

export function requireManagedAuthActorFence(input: {
  mode: ManagedAuthSessionSetMode;
  actorEpoch: string;
  expectedActorEpoch: string | null;
  selectedAuthSessionId: string | null;
  legacyAmbientSessionId?: string | null;
}): void {
  if (
    (input.expectedActorEpoch !== null && input.expectedActorEpoch !== input.actorEpoch) ||
    (input.expectedActorEpoch === null &&
      (input.mode === "broker" ||
        input.actorEpoch !== "1" ||
        (input.selectedAuthSessionId !== null &&
          input.legacyAmbientSessionId !== input.selectedAuthSessionId)))
  ) {
    throw new ManagedAuthActorChangeError();
  }
}

export function managedAuthRandomAuthority(): string {
  return randomBytes(32).toString("base64url");
}

export function managedAuthSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function managedAuthCsrfHash(authority: string): string {
  return managedAuthSha256(`opengeni:managed-auth:csrf-authority:v1\n${authority}`);
}

export function managedAuthCsrfToken(
  signingSecret: string,
  authority: string,
  generation: string,
): string {
  return createHmac("sha256", signingSecret)
    .update(`opengeni:managed-auth:csrf:v1\n${authority}\n${generation}`, "utf8")
    .digest("base64url");
}

export function managedAuthTransactionSecret(
  signingSecret: string,
  authority: string,
  operationId: string,
): string {
  return createHmac("sha256", signingSecret)
    .update(`opengeni:managed-auth:transaction:v1\n${authority}\n${operationId}`, "utf8")
    .digest("base64url");
}

export function managedAuthDerivedUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(`${namespace}\n${value}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function managedAuthRequestDigest(value: unknown): string {
  return managedAuthSha256(canonicalJson(value));
}

export function managedAuthSecretRequestDigest(signingSecret: string, value: unknown): string {
  return createHmac("sha256", signingSecret)
    .update(`opengeni:managed-auth:request:v1\n${canonicalJson(value)}`, "utf8")
    .digest("hex");
}

export function withManagedAuthCsrfToken(
  projection: ManagedAuthDatabaseProjection,
  signingSecret: string,
  authority: string,
): ManagedAuthSessionSetProjection {
  return {
    ...projection,
    csrfToken: managedAuthCsrfToken(signingSecret, authority, projection.generation),
  };
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function requireManagedAuthMutationAdmission(input: {
  request: Request;
  allowedOrigins: readonly string[];
  authority: string;
  signingSecret: string;
  expectedGeneration: string;
}): void {
  const origin = input.request.headers.get("origin");
  const fetchSite = input.request.headers.get("sec-fetch-site");
  const contentType = input.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const csrf = input.request.headers.get(MANAGED_AUTH_CSRF_HEADER);
  const allowed = new Set(input.allowedOrigins.map((candidate) => new URL(candidate).origin));
  const expectedCsrf = managedAuthCsrfToken(
    input.signingSecret,
    input.authority,
    input.expectedGeneration,
  );
  if (
    !origin ||
    !allowed.has(origin) ||
    fetchSite !== "same-origin" ||
    contentType !== "application/json" ||
    !csrf ||
    !equalSecret(csrf, expectedCsrf)
  ) {
    throw new ManagedAuthRequestAdmissionError("Browser session-set mutation admission failed");
  }
}

export async function resolveManagedAuthSelectedSession(input: {
  db: Database;
  adapter: ManagedAuthSessionAdapter;
  authority: string;
  mode: ManagedAuthSessionSetMode;
  expectedActorEpoch: string | null;
  legacyAmbientSessionId?: string | null;
  allowRecovery?: boolean;
}): Promise<{
  session: ManagedAuthResolvedSession | null;
  projection: ManagedAuthDatabaseProjection;
} | null> {
  const snapshot = await getManagedAuthSessionSetSnapshot(input.db, {
    authorityHash: managedAuthSha256(input.authority),
    mode: input.mode,
    includeInternal: true,
    allowRecovery: input.allowRecovery ?? false,
    readOnly: true,
  });
  if (!snapshot) return null;
  if (snapshot.projection.state === "actor_change_required") {
    throw new ManagedAuthActorChangeError();
  }
  requireManagedAuthActorFence({
    mode: input.mode,
    actorEpoch: snapshot.projection.actorEpoch,
    expectedActorEpoch: input.expectedActorEpoch,
    selectedAuthSessionId: snapshot.selected?.authSessionId ?? null,
    legacyAmbientSessionId: input.legacyAmbientSessionId ?? null,
  });
  if (!snapshot.selected) return { session: null, projection: snapshot.projection };
  const resolved = await input.adapter.resolveSelectedSession(snapshot.selected);
  if (
    !resolved ||
    resolved.session.id !== snapshot.selected.authSessionId ||
    resolved.user.id !== snapshot.selected.authUserId
  ) {
    return { session: null, projection: snapshot.projection };
  }
  return { session: resolved, projection: snapshot.projection };
}

export async function authenticateAndAdoptManagedAuthSession(input: {
  db: Database;
  adapter: ManagedAuthSessionAdapter;
  isolatedHeaders: Headers;
  authority: string;
  csrfHash: string;
  operationId: string;
  requestDigest: string;
  expectedGeneration: string;
  expectedActorEpoch: string;
  transactionId: string;
  transactionSecret: string;
  email: string;
  password: string;
  mode: ManagedAuthSessionSetMode;
}): Promise<{ projection: ManagedAuthDatabaseProjection; returnIntent: string | null }> {
  try {
    const existing = await getManagedAuthSessionSetOperationReceipt(input.db, {
      authorityHash: managedAuthSha256(input.authority),
      operationId: input.operationId,
      requestDigest: input.requestDigest,
    });
    if (existing) return existing;
  } catch (error) {
    // Provider authentication creates a durable session. Do not perform it
    // while exact-replay reconciliation is unavailable.
    throw new ManagedAuthCompletionOutcomeUnknownError({ cause: error });
  }
  const created = await input.adapter.authenticate({
    provider: "email_password",
    transactionId: input.transactionId,
    credentials: { email: input.email, password: input.password },
    headers: input.isolatedHeaders,
  });
  return await adoptManagedAuthSession({
    ...input,
    authorityHash: managedAuthSha256(input.authority),
    transactionSecretHash: managedAuthSha256(input.transactionSecret),
    authSessionId: created.authSessionId,
  });
}

export async function adoptManagedAuthSession(input: {
  db: Database;
  adapter: ManagedAuthSessionAdapter;
  authority: string;
  authorityHash: string;
  csrfHash: string;
  operationId: string;
  requestDigest: string;
  expectedGeneration: string;
  expectedActorEpoch: string;
  transactionId: string;
  transactionSecretHash: string;
  authSessionId: string;
  mode: ManagedAuthSessionSetMode;
}): Promise<{ projection: ManagedAuthDatabaseProjection; returnIntent: string | null }> {
  let completed: { projection: ManagedAuthDatabaseProjection; returnIntent: string | null };
  try {
    completed = await completeManagedAuthLoginTransaction(input.db, {
      authorityHash: input.authorityHash,
      csrfHash: input.csrfHash,
      operationId: input.operationId,
      requestDigest: input.requestDigest,
      expectedGeneration: input.expectedGeneration,
      expectedActorEpoch: input.expectedActorEpoch,
      transactionId: input.transactionId,
      transactionSecretHash: input.transactionSecretHash,
      authSessionId: input.authSessionId,
      mode: input.mode,
    });
  } catch (error) {
    let receipt: Awaited<ReturnType<typeof getManagedAuthSessionSetOperationReceipt>>;
    try {
      receipt = await getManagedAuthSessionSetOperationReceipt(input.db, {
        authorityHash: input.authorityHash,
        operationId: input.operationId,
        requestDigest: input.requestDigest,
      });
    } catch (receiptError) {
      throw new ManagedAuthCompletionOutcomeUnknownError({ cause: receiptError });
    }
    if (receipt) {
      await reconcileCreatedManagedAuthSession(input, input.authSessionId);
      return receipt;
    }
    await input.adapter
      .revokeSession({ authSessionId: input.authSessionId })
      .catch(() => undefined);
    throw error;
  }
  try {
    await reconcileCreatedManagedAuthSession(input, input.authSessionId);
  } catch (error) {
    throw new ManagedAuthCompletionOutcomeUnknownError({ cause: error });
  }
  return completed;
}

async function reconcileCreatedManagedAuthSession(
  input: {
    db: Database;
    adapter: ManagedAuthSessionAdapter;
    authority: string;
    mode: ManagedAuthSessionSetMode;
  },
  authSessionId: string,
): Promise<void> {
  const snapshot = await getManagedAuthSessionSetSnapshot(input.db, {
    authorityHash: managedAuthSha256(input.authority),
    mode: input.mode,
    includeInternal: true,
    readOnly: true,
  });
  if (snapshot?.internalSlots.some((slot) => slot.authSessionId === authSessionId)) return;
  await input.adapter.revokeSession({ authSessionId });
}

export function isolatedManagedAuthHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-forwarded-user");
  return headers;
}
