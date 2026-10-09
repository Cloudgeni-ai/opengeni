/**
 * Codex chat turns on the shared subscription core (M3 PR 1).
 *
 * Dormant until an organization's Codex cutover row is enabled: the worker
 * calls into this module only for that disposition. Everything here runs
 * under the exact accepted turn (`withSubscriptionCoreAcceptedTurn`), so a
 * caller cannot use it as a general account, connection or session reader.
 *
 * Core credential plaintext (the format the PR 3 migration maps legacy rows
 * to): `credential_encrypted` holds the same `encryptEnvironmentValue` blob as
 * the legacy Codex tables, whose plaintext is the JSON object
 * `{ access_token, refresh_token, id_token }` with OpenAI's snake_case names.
 * `provider_account_id` is the ChatGPT account id sent as
 * `ChatGPT-Account-ID`, `provider_state.isFedramp` is the FedRAMP routing
 * flag (absent means false), and `plan_type` is the recorded ChatGPT plan.
 * The bearer's `credentialVersion` is the connection's `refresh_generation`,
 * which advances on every persisted refresh and fences quota observations.
 */
import { sql } from "drizzle-orm";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  accessTokenExpiry,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexReloginRequired,
  parseIdToken,
  refreshCodexToken,
} from "@opengeni/codex";
import {
  EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2,
  SubscriptionPersonalAuthorityV2,
  subscriptionPersonalAuthorityForProviderV2,
} from "@opengeni/contracts";
import {
  applyQuotaObservation,
  connectionIneligibility,
  decidePlacement,
  type PlacementInput,
  type PlacementSwitch,
  type SubscriptionQuota,
  type WaitReason,
} from "@opengeni/subscriptions";
import type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { withCodexTokenDeadline } from "./codex-token-resolver";

export type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { rawRows, withRlsContext, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import {
  withSubscriptionCoreAcceptedTurn,
  withSubscriptionCoreCodexRefreshLock,
  withSubscriptionCorePlacementWorld,
  type SubscriptionCoreAcceptedTurnIdentity,
} from "./subscription-core-placement-world";
import {
  acquireSubscriptionTurnLease,
  assertSubscriptionTurnLeaseCurrent,
  decodeSubscriptionQuota,
  persistSubscriptionCodexRefresh,
  readSubscriptionProviderCutoverState,
  readSubscriptionSessionBinding,
  releaseSubscriptionTurnLease,
  writeSubscriptionSessionBinding,
  type SubscriptionSessionBinding,
} from "./subscription-core-repository";

/** The exact accepted turn plus its immutable v2 authority, read once per attempt. */
export type SubscriptionCoreTurnIdentity = SubscriptionCoreAcceptedTurnIdentity & {
  /** Parsed from `session_turns.subscription_authority`; NULL means no personal authority. */
  acceptedAuthorityV2: SubscriptionPersonalAuthorityV2;
};

/** The live chat-turn lease that authorizes credential reads and writes. */
export type SubscriptionCoreCodexLeaseRef = {
  connectionId: string;
  holderId: string;
  generation: number;
};

/**
 * Read the session owner tuple and the turn's immutable v2 authority. The
 * owner is the session's recorded owner and its membership, never a viewer,
 * creator or live-membership inference; NULL authority is no personal
 * authority. A malformed stored value fails closed.
 */
export async function readSubscriptionCoreTurnIdentity(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<SubscriptionCoreTurnIdentity | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{
        owner_subject_id: string | null;
        owner_membership_id: string | null;
        initiating_human_subject_id: string | null;
        subscription_authority: unknown;
      }>(
        tx,
        sql`select session.owner_subject_id,
            session.owner_organization_membership_id::text as owner_membership_id,
            turn.initiating_human_subject_id, turn.subscription_authority
          from sessions session
          join session_turns turn on turn.account_id = session.account_id
            and turn.workspace_id = session.workspace_id and turn.session_id = session.id
          where session.account_id = ${input.accountId}::uuid
            and session.workspace_id = ${input.workspaceId}::uuid
            and session.id = ${input.sessionId}::uuid
            and turn.id = ${input.turnId}::uuid
          limit 1`,
      );
      if (!row) return null;
      return {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sessionOwnerSubjectId: row.owner_subject_id,
        sessionOwnerMembershipId: row.owner_membership_id,
        initiatingHumanSubjectId: row.initiating_human_subject_id,
        acceptedAuthorityV2:
          row.subscription_authority === null
            ? EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2
            : SubscriptionPersonalAuthorityV2.parse(row.subscription_authority),
      };
    },
  );
}

/**
 * The RLS actor that core lease and credential operations run as for this turn.
 *
 * For a service-initiated turn in an owned session the session owner stands in
 * as the actor's initiating human, as `withSubscriptionCoreAcceptedTurn` does,
 * only so the owner's session rows are visible. It grants no personal
 * authority: personal access is decided from the turn's stored
 * `initiating_human_subject_id`, which stays NULL for service turns. The v2
 * placement helper refuses a NULL turn human, and the lease guard's
 * `authorize_subscription_personal_access` matches the stored turn human
 * exactly, so a service turn never leases, reads or refreshes a personal
 * connection.
 */
export function subscriptionCoreTurnActor(identity: SubscriptionCoreAcceptedTurnIdentity): {
  subjectId: string;
  initiatingHumanSubjectId: string | null;
} {
  return {
    subjectId: "service:subscription-core",
    initiatingHumanSubjectId: identity.sessionOwnerSubjectId
      ? (identity.initiatingHumanSubjectId ?? identity.sessionOwnerSubjectId)
      : null,
  };
}

export type SubscriptionCoreCodexPlacementRequest = {
  identity: SubscriptionCoreTurnIdentity;
  attemptId: string;
  executionGeneration: number;
  holderId: string;
  /** The turn's accepted product model; M3 places Codex models only. */
  productModelId: string;
  reasoningLevel: string;
  leaseTtlMs: number;
  now?: Date;
};

export type SubscriptionCoreCodexPlacement =
  | { kind: "not_visible" }
  /** The organization's Codex cutover is not enabled (checked in the same transaction). */
  | { kind: "cutover_not_enabled" }
  /** Another attempt owns the turn, or a newer lease generation exists. */
  | { kind: "attempt_fenced" }
  /** An older attempt's lease of this turn is still live; it expires at `leasedUntil`. */
  | { kind: "lease_busy"; leasedUntil: Date | null }
  | {
      kind: "wait";
      reason: WaitReason;
      earliestResetAt: Date | null;
      explicitConnectionId: string | null;
    }
  | {
      kind: "run";
      connectionId: string;
      personal: boolean;
      switch: PlacementSwitch;
      /** This exact attempt already held a live lease on the connection. */
      reusedLease: boolean;
      explicit: boolean;
      previousConnectionId: string | null;
      rotationMode: "primary_first" | "spread";
      refreshGeneration: number;
      leasedUntil: Date;
      eligibleCount: number;
      connectedCount: number;
    };

class SubscriptionBindingConflict extends Error {
  constructor() {
    super("Subscription session binding changed during placement");
    this.name = "SubscriptionBindingConflict";
  }
}

const BINDING_CONFLICT_RETRIES = 3;

/**
 * Place one Codex chat turn on the core and acquire its generation-fenced
 * lease in one transaction. Strict M3 policy: Codex models only (the turn's
 * accepted product model), no cross-provider failover, explicit choices are
 * honoured or wait (D-24), and the binding is written only through its
 * compare-and-swap API. Ownerless sessions never write a binding (the
 * database refuses one without an exact turn) and are shared-only.
 */
export async function placeSubscriptionCoreCodexTurn(
  db: Database,
  request: SubscriptionCoreCodexPlacementRequest,
): Promise<SubscriptionCoreCodexPlacement> {
  if (!Number.isSafeInteger(request.executionGeneration) || request.executionGeneration < 1)
    throw new Error("Core Codex placement requires a positive execution generation");
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await placeOnce(db, request);
    } catch (error) {
      if (!(error instanceof SubscriptionBindingConflict) || attempt >= BINDING_CONFLICT_RETRIES)
        throw error;
    }
  }
}

async function placeOnce(
  db: Database,
  request: SubscriptionCoreCodexPlacementRequest,
): Promise<SubscriptionCoreCodexPlacement> {
  const { identity } = request;
  const now = request.now ?? new Date();
  const result = await withSubscriptionCorePlacementWorld(
    db,
    {
      ...identity,
      preferredModelId: request.productModelId,
      reasoningLevel: request.reasoningLevel,
      // Codex only: Claude and SuperGrok stay on their v1 selectors in M3.
      models: [
        {
          id: request.productModelId,
          provider: "codex",
          reasoningLevels: [request.reasoningLevel],
        },
      ],
      reselectionPoints: [],
      now,
    },
    async (tx, worldInput): Promise<SubscriptionCoreCodexPlacement> => {
      if (!(await codexCutoverEnabled(tx, identity.accountId)))
        return { kind: "cutover_not_enabled" };
      const fence = await readAttemptFence(tx, request);
      if (!fence) return { kind: "attempt_fenced" };

      const input: PlacementInput = {
        ...worldInput,
        settings: { ...worldInput.settings, crossProviderFailover: false, fallbackOrder: {} },
        connections: worldInput.connections.filter((connection) => connection.provider === "codex"),
      };
      const lease = {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        provider: "codex" as const,
        holderId: request.holderId,
        generation: request.executionGeneration,
      };

      // Exact-turn reuse first: a Temporal retry of this same attempt keeps
      // its live lease while the connection can still serve the turn.
      const existing = await readTurnLease(tx, identity);
      let reuse: string | null = null;
      if (existing) {
        const ours =
          existing.holderId === request.holderId &&
          existing.generation === request.executionGeneration;
        // A newer or equal generation held by someone else is not this attempt.
        if (!ours && existing.generation >= request.executionGeneration) {
          return { kind: "attempt_fenced" };
        }
        // An older attempt's lease is replaced only after it expires.
        if (!ours && existing.live) {
          return { kind: "lease_busy", leasedUntil: existing.leasedUntil };
        }
        if (ours) {
          const connection = input.connections.find((row) => row.id === existing.connectionId);
          const servable =
            existing.live &&
            connection !== undefined &&
            connectionIneligibility(input, connection, request.productModelId).length === 0;
          if (servable) reuse = existing.connectionId;
          else
            await releaseSubscriptionTurnLease(tx, {
              ...lease,
              connectionId: existing.connectionId,
            });
        }
      }

      const binding = input.session.binding;
      const explicitConnectionId = binding?.choice === "explicit" ? binding.connectionId : null;
      const decision =
        reuse !== null && (explicitConnectionId === null || explicitConnectionId === reuse)
          ? ({ kind: "run", connectionId: reuse, switch: "sticky" } as const)
          : decidePlacement(input);
      if (decision.kind === "wait") {
        if (reuse !== null)
          await releaseSubscriptionTurnLease(tx, { ...lease, connectionId: reuse });
        return {
          kind: "wait",
          reason: decision.reason,
          earliestResetAt:
            decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
          explicitConnectionId,
        };
      }
      if (reuse !== null && decision.connectionId !== reuse) {
        await releaseSubscriptionTurnLease(tx, { ...lease, connectionId: reuse });
      }
      const connection = input.connections.find((row) => row.id === decision.connectionId);
      if (!connection) throw new Error("Core placement chose a connection outside its world");
      const acquired = await acquireSubscriptionTurnLease(tx, {
        ...lease,
        connectionId: connection.id,
        ttlMs: request.leaseTtlMs,
      });
      if (!acquired) return { kind: "lease_busy", leasedUntil: existing?.leasedUntil ?? null };

      const previousConnectionId = binding?.connectionId ?? null;
      if (identity.sessionOwnerSubjectId) {
        await writeBinding(tx, identity, {
          connectionId: connection.id,
          modelId: request.productModelId,
          placementSwitch: decision.switch,
        });
      }
      const rotation = input.settings.rotation.codex;
      return {
        kind: "run",
        connectionId: connection.id,
        personal: connection.ownership.kind === "personal",
        switch: decision.switch,
        reusedLease: reuse === connection.id,
        explicit: explicitConnectionId === connection.id,
        previousConnectionId,
        rotationMode: rotation?.mode ?? "spread",
        refreshGeneration: connection.refreshGeneration,
        leasedUntil: acquired.leasedUntil,
        eligibleCount: input.connections.filter(
          (row) => connectionIneligibility(input, row, request.productModelId).length === 0,
        ).length,
        connectedCount: input.connections.length,
      };
    },
  );
  return result.status === "not_visible" ? { kind: "not_visible" } : result.value;
}

/** Defense in depth: core reads and writes re-check the gate in their own transaction. */
async function codexCutoverEnabled(tx: Database, accountId: string): Promise<boolean> {
  return (
    (await readSubscriptionProviderCutoverState(tx, { accountId, provider: "codex" })) === "enabled"
  );
}

async function readAttemptFence(
  tx: Database,
  request: SubscriptionCoreCodexPlacementRequest,
): Promise<boolean> {
  const { identity } = request;
  const [row] = await rawRows<{
    status: string;
    active_attempt_id: string | null;
    execution_generation: number | string;
    session_status: string;
    active_turn_id: string | null;
  }>(
    tx,
    sql`select turn.status, turn.active_attempt_id::text as active_attempt_id,
        turn.execution_generation, session.status as session_status,
        session.active_turn_id::text as active_turn_id
      from session_turns turn
      join sessions session on session.account_id = turn.account_id
        and session.workspace_id = turn.workspace_id and session.id = turn.session_id
      where turn.account_id = ${identity.accountId}::uuid
        and turn.workspace_id = ${identity.workspaceId}::uuid
        and turn.session_id = ${identity.sessionId}::uuid
        and turn.id = ${identity.turnId}::uuid
      limit 1`,
  );
  return (
    row !== undefined &&
    row.status === "running" &&
    row.session_status === "running" &&
    row.active_turn_id === identity.turnId &&
    row.active_attempt_id === request.attemptId &&
    Number(row.execution_generation) === request.executionGeneration
  );
}

async function readTurnLease(
  tx: Database,
  identity: SubscriptionCoreAcceptedTurnIdentity,
): Promise<{
  connectionId: string;
  holderId: string;
  generation: number;
  leasedUntil: Date;
  live: boolean;
} | null> {
  const [row] = await rawRows<{
    connection_id: string;
    provider: string;
    holder_id: string;
    generation: number | string;
    leased_until: Date | string;
    live: boolean;
  }>(
    tx,
    sql`select connection_id::text as connection_id, provider, holder_id, generation,
        leased_until, leased_until > clock_timestamp() as live
      from subscription_leases
      where account_id = ${identity.accountId}::uuid
        and workspace_id = ${identity.workspaceId}::uuid
        and session_id = ${identity.sessionId}::uuid
        and turn_id = ${identity.turnId}::uuid`,
  );
  if (!row) return null;
  if (row.provider !== "codex") throw new Error("A core turn lease belongs to another provider");
  return {
    connectionId: row.connection_id,
    holderId: row.holder_id,
    generation: Number(row.generation),
    leasedUntil: new Date(row.leased_until),
    live: row.live,
  };
}

function bindingSwitchReason(
  placementSwitch: PlacementSwitch,
  current: SubscriptionSessionBinding["lastSwitchReason"],
): SubscriptionSessionBinding["lastSwitchReason"] {
  return placementSwitch === "sticky" || placementSwitch === "pinned" ? current : placementSwitch;
}

async function writeBinding(
  tx: Database,
  identity: SubscriptionCoreAcceptedTurnIdentity,
  next: { connectionId: string; modelId: string; placementSwitch: PlacementSwitch },
): Promise<void> {
  const current = await readSubscriptionSessionBinding(tx, identity);
  if (
    current &&
    current.provider === "codex" &&
    current.connectionId === next.connectionId &&
    current.modelId === next.modelId
  ) {
    return;
  }
  const written = await writeSubscriptionSessionBinding(tx, {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    provider: "codex",
    connectionId: next.connectionId,
    modelId: next.modelId,
    // A person's explicit choice is changed only by that person.
    choice: current?.choice ?? "automatic",
    onlyThisModel: current?.onlyThisModel ?? false,
    lastModelCallAt: current?.lastModelCallAt ?? null,
    lastSwitchReason: bindingSwitchReason(next.placementSwitch, current?.lastSwitchReason ?? null),
    expectedVersion: current?.version ?? null,
  });
  if (written === null) throw new SubscriptionBindingConflict();
}

/**
 * Give this transaction the per-connection personal capability for the
 * turn's frozen v2 Codex entry. A no-op without that entry, for service and
 * ownerless turns, and before the Codex cutover is enabled.
 */
async function authorizeFrozenPersonalCodex(
  tx: Database,
  identity: SubscriptionCoreTurnIdentity,
): Promise<boolean> {
  const personal = subscriptionPersonalAuthorityForProviderV2(
    identity.acceptedAuthorityV2,
    "codex",
  );
  if (
    !personal ||
    !identity.sessionOwnerSubjectId ||
    !identity.initiatingHumanSubjectId ||
    identity.sessionOwnerMembershipId !== personal.ownerMembershipId
  ) {
    return false;
  }
  const [row] = await rawRows<{ authorized: boolean }>(
    tx,
    sql`select opengeni_private.authorize_subscription_personal_placement_access(
        ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
        ${identity.sessionId}::uuid, ${identity.turnId}::uuid, 'codex',
        ${personal.ownerMembershipId}::uuid, ${personal.authorityGeneration}::bigint,
        ${identity.sessionOwnerSubjectId}, ${identity.initiatingHumanSubjectId}
      ) as authorized`,
  );
  return row?.authorized === true;
}

/** Exact accepted turn + live lease + (for personal) frozen v2 authority. */
async function withLeasedCodexConnection<T>(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  operation: (tx: Database) => Promise<T>,
): Promise<{ status: "not_visible" } | { status: "lease_lost" } | { status: "ok"; value: T }> {
  const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    if (!(await codexCutoverEnabled(tx, identity.accountId)))
      return { status: "not_visible" } as const;
    const current = await assertSubscriptionTurnLeaseCurrent(tx, {
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      provider: "codex",
      connectionId: lease.connectionId,
      holderId: lease.holderId,
      generation: lease.generation,
    });
    if (!current) return { status: "lease_lost" } as const;
    await authorizeFrozenPersonalCodex(tx, identity);
    return { status: "ok", value: await operation(tx) } as const;
  });
  return access.status === "not_visible" ? access : access.value;
}

export type SubscriptionCoreCodexCredential = {
  connectionId: string;
  ownership: "shared" | "personal";
  refreshGeneration: number;
  tokens: { accessToken: string; refreshToken: string; idToken: string };
  chatgptAccountId: string | null;
  isFedramp: boolean;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreCodexCredentialLoad =
  | { kind: "loaded"; credential: SubscriptionCoreCodexCredential }
  | { kind: "lease_lost" }
  /** The turn, or the connection under its authority, is not visible. */
  | { kind: "not_visible" }
  | { kind: "needs_relogin" }
  | { kind: "unavailable" };

function decodeCodexTokens(
  key: Uint8Array,
  encrypted: string,
): SubscriptionCoreCodexCredential["tokens"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptEnvironmentValue(key, encrypted));
  } catch {
    // Fixed text and no cause: a JSON.parse message quotes the plaintext it
    // failed on, and runtimes print a cause's message with the error.
    throw new Error("A core Codex credential could not be decrypted");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.id_token !== "string"
  ) {
    throw new Error("A core Codex credential does not hold the expected token object");
  }
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    idToken: record.id_token,
  };
}

function encryptionKey(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "core Codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  return key;
}

/**
 * Materialize the leased connection's credential for this exact turn. Reads
 * require the accepted turn, the live lease, and for a personal connection
 * the turn's frozen v2 entry. Ownerless turns never read a personal or
 * people-scoped connection.
 */
export async function loadSubscriptionCoreCodexCredential(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
): Promise<SubscriptionCoreCodexCredentialLoad> {
  const key = encryptionKey(settings);
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const [row] = await rawRows<{
      id: string;
      kind: string;
      status: string;
      ownership: "shared" | "personal";
      scope_kind: string;
      credential_encrypted: string;
      expires_at: Date | string | null;
      last_refresh_at: Date | string | null;
      refresh_generation: number | string;
      provider_account_id: string | null;
      plan_type: string | null;
      provider_state: Record<string, unknown> | null;
    }>(
      tx,
      sql`select id::text as id, kind, status, ownership, scope_kind, credential_encrypted,
          expires_at, last_refresh_at, refresh_generation, provider_account_id, plan_type,
          provider_state
        from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = 'codex'
          and id = ${lease.connectionId}::uuid
        limit 1`,
    );
    return row ?? null;
  });
  if (access.status !== "ok") return { kind: access.status };
  const row = access.value;
  if (!row) return { kind: "not_visible" };
  if (
    identity.sessionOwnerSubjectId === null &&
    (row.ownership !== "shared" ||
      (row.scope_kind !== "organization" && row.scope_kind !== "workspaces"))
  ) {
    return { kind: "not_visible" };
  }
  if (row.kind !== "subscription") return { kind: "unavailable" };
  if (row.status === "needs_relogin") return { kind: "needs_relogin" };
  if (row.status !== "active") return { kind: "unavailable" };
  return {
    kind: "loaded",
    credential: {
      connectionId: row.id,
      ownership: row.ownership,
      refreshGeneration: Number(row.refresh_generation),
      tokens: decodeCodexTokens(key, row.credential_encrypted),
      chatgptAccountId: row.provider_account_id,
      isFedramp: row.provider_state?.isFedramp === true,
      planType: row.plan_type,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
      lastRefreshAt: row.last_refresh_at === null ? null : new Date(row.last_refresh_at),
    },
  };
}

export type SubscriptionCoreCodexRefreshOutcome =
  | {
      kind: "refreshed";
      accessToken: string;
      refreshGeneration: number;
      planType: string | null;
    }
  /** Another refresh or credential writer already advanced the generation. */
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "lease_lost" }
  | { kind: "not_visible" }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreCodexRefreshDeps = {
  refresh?: typeof refreshCodexToken;
  now?: () => Date;
};

/**
 * Rotate the leased connection's refresh token through the core's single
 * per-connection lock. Authorization happens in begin, before the provider
 * call; the rotated token is persisted immediately after it returns. A
 * permanent OAuth refusal marks the connection needs-relogin through the
 * same one-shot authorization. Failures are returned, never thrown inside
 * the lock, so that status write commits.
 */
export async function refreshSubscriptionCoreCodexCredential(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  observedRefreshGeneration: number,
  deps: SubscriptionCoreCodexRefreshDeps = {},
): Promise<SubscriptionCoreCodexRefreshOutcome> {
  const key = encryptionKey(settings);
  const refresh = deps.refresh ?? refreshCodexToken;
  const now = deps.now ?? (() => new Date());
  const result = await withSubscriptionCoreCodexRefreshLock(
    db,
    {
      ...identity,
      connectionId: lease.connectionId,
      holderId: lease.holderId,
      generation: lease.generation,
    },
    async (tx, credential): Promise<SubscriptionCoreCodexRefreshOutcome> => {
      // Switch-off fails closed before any provider call.
      if (!(await codexCutoverEnabled(tx, identity.accountId))) return { kind: "refused" };
      if (credential.refreshGeneration !== observedRefreshGeneration) return { kind: "superseded" };
      try {
        const tokens = decodeCodexTokens(key, credential.credentialEncrypted);
        const next = await withCodexTokenDeadline(refresh(tokens.refreshToken));
        const rotated = {
          access_token: next.accessToken ?? tokens.accessToken,
          refresh_token: next.refreshToken ?? tokens.refreshToken,
          id_token: next.idToken ?? tokens.idToken,
        };
        // Persist before any other fallible work: a rolled-back transaction
        // would discard the only valid refresh token.
        const persisted = await persistSubscriptionCodexRefresh(tx, {
          accountId: identity.accountId,
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          connectionId: lease.connectionId,
          expectedRefreshGeneration: credential.refreshGeneration,
          credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify(rotated)),
          expiresAt: accessTokenExpiry(rotated.access_token),
          lastRefreshAt: now(),
        });
        if (!persisted) return { kind: "superseded" };
        let planType: string | null = null;
        try {
          planType = next.idToken ? parseIdToken(next.idToken).planType : null;
        } catch {
          planType = null;
        }
        return {
          kind: "refreshed",
          accessToken: rotated.access_token,
          refreshGeneration: credential.refreshGeneration + 1,
          planType,
        };
      } catch (error) {
        if (error instanceof CodexReloginRequired) {
          const [marked] = await rawRows<{ marked: boolean }>(
            tx,
            sql`select opengeni_private.fail_subscription_codex_refresh(
                ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
                ${identity.sessionId}::uuid, ${identity.turnId}::uuid,
                ${lease.connectionId}::uuid, ${credential.refreshGeneration}::bigint,
                ${error.message}
              ) as marked`,
          );
          return { kind: "relogin", message: error.message, marked: marked?.marked === true };
        }
        return { kind: "error", error };
      }
    },
  );
  if (result.status !== "completed") return { kind: result.status };
  return result.value;
}

/** Raised when the turn no longer holds its core lease; dispatch must stop. */
export class SubscriptionCoreCodexLeaseLostError extends Error {
  readonly code = "codex_credential_lease_lost";
  constructor() {
    super("The core Codex lease for this turn is no longer current");
    this.name = "SubscriptionCoreCodexLeaseLostError";
  }
}

type CoreRefreshFlight = {
  /** The exact turn lease that started this provider refresh. */
  holderKey: string;
  promise: Promise<SubscriptionCoreCodexRefreshOutcome>;
};

/**
 * The turn lost access to its leased connection mid-turn (the connection, or
 * the turn's authority over it, is no longer visible, enabled or usable).
 * Distinct from a revoked sign-in, which is `CodexReloginRequired`.
 */
export class SubscriptionCoreCodexAccessLostError extends Error {
  readonly code = "subscription_core_access_lost";
  constructor() {
    super("This turn can no longer use its Codex subscription");
    this.name = "SubscriptionCoreCodexAccessLostError";
  }
}

const coreInflight = new Map<string, CoreRefreshFlight>();

/**
 * Outcomes about the connection itself, which every turn waiting on the same
 * connection and generation may share. A lost lease, a refused authorization
 * or an invisible connection belongs to the turn that hit it only.
 */
function connectionLevelRefreshOutcome(outcome: SubscriptionCoreCodexRefreshOutcome): boolean {
  return (
    outcome.kind === "refreshed" ||
    outcome.kind === "superseded" ||
    outcome.kind === "relogin" ||
    outcome.kind === "error"
  );
}

/** Test seams; production uses the database-backed defaults. */
export type SubscriptionCoreCodexResolverDeps = SubscriptionCoreCodexRefreshDeps & {
  load?: typeof loadSubscriptionCoreCodexCredential;
  refreshCredential?: typeof refreshSubscriptionCoreCodexCredential;
};

/**
 * The core counterpart of `buildCodexTokenResolver`: same snapshot shape,
 * proactive staleness refresh and local single-flight, but every read and
 * refresh is scoped to the exact accepted turn and its live lease.
 */
export function buildSubscriptionCoreCodexTokenResolver(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  deps: SubscriptionCoreCodexResolverDeps = {},
): {
  getToken: () => Promise<CodexCredentialTokenSnapshot>;
  refresh: () => Promise<CodexCredentialTokenSnapshot>;
} {
  const loadCredential = deps.load ?? loadSubscriptionCoreCodexCredential;
  const refreshCredential = deps.refreshCredential ?? refreshSubscriptionCoreCodexCredential;
  const holderKey = `${identity.turnId}:${lease.holderId}:${lease.generation}`;
  const load = async (): Promise<SubscriptionCoreCodexCredential> => {
    const loaded = await loadCredential(db, settings, identity, lease);
    switch (loaded.kind) {
      case "loaded":
        return loaded.credential;
      case "lease_lost":
        throw new SubscriptionCoreCodexLeaseLostError();
      case "needs_relogin":
        throw new CodexReloginRequired("The Codex subscription for this turn needs a new sign-in.");
      default:
        throw new SubscriptionCoreCodexAccessLostError();
    }
  };
  const snapshot = (credential: SubscriptionCoreCodexCredential): CodexCredentialTokenSnapshot => ({
    accessToken: credential.tokens.accessToken,
    chatgptAccountId: credential.chatgptAccountId,
    isFedramp: credential.isFedramp,
    credentialVersion: credential.refreshGeneration,
    planType: credential.planType,
  });
  const runOwnRefresh = (credential: SubscriptionCoreCodexCredential) =>
    refreshCredential(db, settings, identity, lease, credential.refreshGeneration, deps);
  const sharedRefresh = async (
    credential: SubscriptionCoreCodexCredential,
  ): Promise<SubscriptionCoreCodexRefreshOutcome> => {
    // Process-wide single-flight per canonical connection and generation;
    // the database advisory lock serializes other replicas.
    const key = `core:${lease.connectionId}:${credential.refreshGeneration}`;
    const existing = coreInflight.get(key);
    if (existing) {
      const outcome = await existing.promise;
      // Another turn's lease or authorization outcome is not this turn's:
      // refresh under this turn's own lease instead.
      return existing.holderKey === holderKey || connectionLevelRefreshOutcome(outcome)
        ? outcome
        : await runOwnRefresh(credential);
    }
    const flight: CoreRefreshFlight = {
      holderKey,
      promise: Promise.resolve() as unknown as Promise<SubscriptionCoreCodexRefreshOutcome>,
    };
    flight.promise = runOwnRefresh(credential).finally(() => {
      if (coreInflight.get(key) === flight) coreInflight.delete(key);
    });
    coreInflight.set(key, flight);
    return await flight.promise;
  };
  const doRefresh = async (
    credential: SubscriptionCoreCodexCredential,
  ): Promise<CodexCredentialTokenSnapshot> => {
    const outcome = await sharedRefresh(credential);
    switch (outcome.kind) {
      case "refreshed":
        return {
          accessToken: outcome.accessToken,
          chatgptAccountId: credential.chatgptAccountId,
          isFedramp: credential.isFedramp,
          credentialVersion: outcome.refreshGeneration,
          planType: outcome.planType ?? credential.planType,
        };
      case "superseded":
        return snapshot(await load());
      case "relogin":
        throw new CodexReloginRequired(outcome.message);
      case "lease_lost":
        throw new SubscriptionCoreCodexLeaseLostError();
      case "error":
        throw outcome.error;
      default:
        throw new SubscriptionCoreCodexAccessLostError();
    }
  };
  const resolve = async (force: boolean): Promise<CodexCredentialTokenSnapshot> => {
    const credential = await load();
    const expiry = credential.expiresAt ?? accessTokenExpiry(credential.tokens.accessToken);
    const stale =
      force ||
      (expiry
        ? expiry.getTime() <= Date.now() + CODEX_REFRESH_WINDOW_MS
        : credential.lastRefreshAt
          ? credential.lastRefreshAt.getTime() < Date.now() - CODEX_REFRESH_FALLBACK_MS
          : true);
    return stale ? await doRefresh(credential) : snapshot(credential);
  };
  return { getToken: () => resolve(false), refresh: () => resolve(true) };
}

/**
 * Apply one quota observation (usage headers or a refusal) to the leased
 * connection. The observation applies only to the refresh generation it was
 * made with, and never shortens a running exhaustion (design 2.2).
 */
export async function recordSubscriptionCoreCodexQuotaObservation(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  observation: SubscriptionQuota,
): Promise<boolean> {
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const [connection] = await rawRows<{ refresh_generation: number | string }>(
      tx,
      sql`select refresh_generation from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = 'codex'
          and id = ${lease.connectionId}::uuid`,
    );
    if (!connection) return false;
    const refreshGeneration = Number(connection.refresh_generation);
    const [row] = await rawRows<{
      quota: unknown;
      quota_revision: number | string | null;
      quota_observed_refresh_generation: number | string | null;
      quota_updated_at: Date | string | null;
    }>(
      tx,
      sql`select quota, revision as quota_revision,
          observed_refresh_generation as quota_observed_refresh_generation,
          updated_at as quota_updated_at
        from subscription_connection_quota
        where account_id = ${identity.accountId}::uuid and connection_id = ${lease.connectionId}::uuid
        for update`,
    );
    const current = row ? decodeSubscriptionQuota(row) : null;
    const next = applyQuotaObservation({ refreshGeneration, quota: current }, observation);
    if (!next || next === current) return false;
    const stored = {
      windows: next.windows,
      modelCooldowns: next.modelCooldowns,
      exhaustedUntil: next.exhaustedUntil,
      exhaustedKind: next.exhaustedKind,
      source: next.source,
    };
    const observedAt = new Date(next.observedAt ?? Date.now()).toISOString();
    await tx.execute(
      sql`insert into subscription_connection_quota (
          account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
        ) values (
          ${identity.accountId}::uuid, ${lease.connectionId}::uuid, ${JSON.stringify(stored)}::jsonb,
          ${refreshGeneration}, 1, ${observedAt}::timestamptz
        )
        on conflict (connection_id) do update
          set quota = excluded.quota,
              observed_refresh_generation = excluded.observed_refresh_generation,
              revision = subscription_connection_quota.revision + 1,
              updated_at = excluded.updated_at
          where subscription_connection_quota.account_id = excluded.account_id`,
    );
    return true;
  });
  return access.status === "ok" && access.value;
}

/** A (turn, connection) failure receipt for core settlement and audit. */
export async function recordSubscriptionCoreCodexTurnFailure(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  failure: { kind: string; evidence?: Record<string, string | number | boolean | null> },
): Promise<boolean> {
  // Exact accepted turn, enabled gate and this turn's live lease, as for
  // every other core write about the leased connection.
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const rows = await rawRows<{ turn_id: string }>(
      tx,
      sql`insert into subscription_turn_failures (
          account_id, workspace_id, session_id, turn_id, connection_id, provider,
          failure_kind, recovery_evidence
        ) values (
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid, ${identity.sessionId}::uuid,
          ${identity.turnId}::uuid, ${lease.connectionId}::uuid, 'codex', ${failure.kind},
          ${JSON.stringify(failure.evidence ?? {})}::jsonb
        )
        on conflict (workspace_id, turn_id, connection_id) do update
          set failure_kind = excluded.failure_kind,
              recovery_evidence = excluded.recovery_evidence
          where subscription_turn_failures.account_id = excluded.account_id
        returning turn_id::text as turn_id`,
    );
    return rows.length === 1;
  });
  return access.status === "ok" && access.value;
}

/**
 * Record a completed model call on the session's chat binding so the next
 * placement measures cache warmth from it (design 3.4). Only the leased
 * connection's binding moves, and only forward, through the binding CAS.
 */
export async function touchSubscriptionCoreCodexBinding(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  lastModelCallAt: Date,
): Promise<boolean> {
  if (!identity.sessionOwnerSubjectId) return false;
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const current = await readSubscriptionSessionBinding(tx, identity);
    if (
      !current ||
      current.provider !== "codex" ||
      current.connectionId !== lease.connectionId ||
      (current.lastModelCallAt !== null && current.lastModelCallAt >= lastModelCallAt)
    ) {
      return false;
    }
    const written = await writeSubscriptionSessionBinding(tx, {
      ...current,
      lastModelCallAt,
      expectedVersion: current.version,
    });
    return written !== null;
  });
  return access.status === "ok" && access.value;
}
