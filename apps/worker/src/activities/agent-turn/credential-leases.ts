import {
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  SUBSCRIPTION_CORE_CLAUDE_LEASE_TTL_MS,
  releaseSubscriptionTurnLease,
  heartbeatXaiCredentialLeaseUntil,
  assertSubscriptionTurnLeaseCurrent,
  renewSubscriptionTurnLease,
  withRlsContext,
  withSessionRlsActorContext,
} from "@opengeni/db";
import type { SharedActivityServices } from "../types";
import {
  SubscriptionTurnLease,
  type LeaseRenewReason,
  type LeaseLossReason,
  type SubscriptionLeaseDeps,
} from "./subscription-lease";
export type { LeaseRenewReason, LeaseLossReason } from "./subscription-lease";
import { safeErrorDiagnostic } from "./errors";

export class CodexCredentialLeaseLostError extends Error {
  readonly code = "codex_credential_lease_lost";

  constructor(readonly reason: LeaseLossReason) {
    super("Codex credential lease is not usable for provider dispatch");
    this.name = "CodexCredentialLeaseLostError";
  }
}

/** Core service actor for one exact accepted turn (see subscriptionCoreTurnActor). */
export type CoreLeaseActor = { subjectId: string; initiatingHumanSubjectId: string | null };

export type TurnCredentialLeaseDeps = {
  db: SharedActivityServices["db"];
  observability: SharedActivityServices["observability"];
  accountId: string;
  workspaceId: string;
  codexWorkspaceKey: string;
  getTurnId: () => string | undefined;
  getSessionId?: () => string | undefined;
};

type LeaseCallbacks = Pick<SubscriptionLeaseDeps, "onLost" | "onRenewed" | "onError" | "lostError">;

/**
 * A turn's serving-credential holder that can hold a shared-core lease, for
 * any provider (generalized from the M3 Codex lease). After core placement
 * (`useSubscriptionCoreLease`) heartbeat renewal, the dispatch fence and
 * release go to the canonical per-turn `subscription_leases` row of this
 * provider; before it, a provider with a legacy lease keeps its own
 * heartbeat. The DB row is the cross-replica fairness primitive; the
 * heartbeat here only extends its short TTL. A killed worker stops
 * heartbeating and the holder self-expires.
 */
export class CoreSubscriptionTurnLease extends SubscriptionTurnLease {
  private readonly coreDeps: TurnCredentialLeaseDeps;
  private readonly coreProvider: { id: string; displayName: string; ttlMs: number };
  private subscriptionCoreConnectionId: string | null = null;
  private subscriptionCoreActor: CoreLeaseActor | null = null;

  constructor(
    deps: TurnCredentialLeaseDeps,
    provider: {
      /** The provider id on the core (`subscription_leases.provider`). */
      id: string;
      displayName: string;
      ttlMs: number;
      /** The legacy heartbeat used while no core lease is held (none: no renewal). */
      legacyHeartbeat?: SubscriptionLeaseDeps["heartbeat"];
    },
    callbacks: LeaseCallbacks,
  ) {
    super({
      ttlMs: provider.ttlMs,
      getTurnId: deps.getTurnId,
      heartbeat: (identity) => {
        const connectionId = this.subscriptionCoreConnectionId;
        if (connectionId) {
          const sessionId = deps.getSessionId?.();
          if (!sessionId) return Promise.resolve(null);
          return this.inCoreScope(() =>
            withRlsContext(
              deps.db,
              { accountId: deps.accountId, workspaceId: deps.workspaceId },
              (scoped) =>
                renewSubscriptionTurnLease(scoped, {
                  accountId: deps.accountId,
                  workspaceId: deps.workspaceId,
                  sessionId,
                  turnId: identity.turnId,
                  provider: provider.id,
                  connectionId,
                  holderId: identity.holderId,
                  generation: identity.generation,
                  ttlMs: provider.ttlMs,
                }),
            ),
          );
        }
        return provider.legacyHeartbeat
          ? provider.legacyHeartbeat(identity)
          : Promise.resolve(null);
      },
      ...callbacks,
    });
    this.coreDeps = deps;
    this.coreProvider = provider;
  }

  /**
   * Route heartbeat renewal, dispatch fencing and release to the canonical
   * per-turn lease after core placement. The actor is the core service actor
   * for the exact accepted turn, so the lease row's session isolation does
   * not depend on whatever ambient actor the caller happens to run under.
   */
  useSubscriptionCoreLease(connectionId: string, actor?: CoreLeaseActor): void {
    if (!connectionId.trim())
      throw new Error(`Core ${this.coreProvider.displayName} lease connection id is required`);
    this.subscriptionCoreConnectionId = connectionId;
    this.subscriptionCoreActor = actor ?? null;
  }

  /** The core connection this lease holds, or null before placement. */
  get subscriptionCoreConnection(): string | null {
    return this.subscriptionCoreConnectionId;
  }

  private inCoreScope<T>(operation: () => Promise<T>): Promise<T> {
    const actor = this.subscriptionCoreActor;
    return actor ? withSessionRlsActorContext(actor, operation) : operation();
  }

  /** Recheck the canonical lease at the last boundary before provider network I/O. */
  async assertCurrentForDispatch(): Promise<void> {
    this.assertUsable();
    const connectionId = this.subscriptionCoreConnectionId;
    const turnId = this.coreDeps.getTurnId();
    const sessionId = this.coreDeps.getSessionId?.();
    if (!connectionId || !turnId || !sessionId || !this.holderId || this.generation === null) {
      this.markLost("not_found");
      this.assertUsable();
      return;
    }
    const holderId = this.holderId;
    const generation = this.generation;
    const current = await this.inCoreScope(() =>
      withRlsContext(
        this.coreDeps.db,
        { accountId: this.coreDeps.accountId, workspaceId: this.coreDeps.workspaceId },
        (scoped) =>
          assertSubscriptionTurnLeaseCurrent(scoped, {
            accountId: this.coreDeps.accountId,
            workspaceId: this.coreDeps.workspaceId,
            sessionId,
            turnId,
            provider: this.coreProvider.id,
            connectionId,
            holderId,
            generation,
          }),
      ),
    );
    // The DB round trip can outlive the local lease deadline or a heartbeat
    // can mark this holder lost while it is in flight. A stale positive reply
    // is not dispatch authority.
    this.assertUsable();
    if (
      this.subscriptionCoreConnectionId !== connectionId ||
      this.holderId !== holderId ||
      this.generation !== generation
    ) {
      this.markLost("not_found");
      this.assertUsable();
    }
    if (!current) {
      this.markLost("not_found");
      this.assertUsable();
    }
  }

  /** Release the core lease that this turn's placement acquired (false without one). */
  async releaseCurrent(): Promise<boolean> {
    const turnId = this.coreDeps.getTurnId();
    if (!turnId || !this.holderId || this.generation === null) return false;
    const connectionId = this.subscriptionCoreConnectionId;
    if (!connectionId) return false;
    const sessionId = this.coreDeps.getSessionId?.();
    if (!sessionId) return false;
    return await this.inCoreScope(() =>
      withRlsContext(
        this.coreDeps.db,
        { accountId: this.coreDeps.accountId, workspaceId: this.coreDeps.workspaceId },
        (scoped) =>
          releaseSubscriptionTurnLease(scoped, {
            accountId: this.coreDeps.accountId,
            workspaceId: this.coreDeps.workspaceId,
            sessionId,
            turnId,
            provider: this.coreProvider.id,
            connectionId,
            holderId: this.holderId!,
            generation: this.generation!,
          }),
      ),
    );
  }
}

/**
 * The Codex credential holder for one running turn: the core turn lease with
 * Codex's lost error, metrics and log texts (Codex has no legacy lease).
 */
export class CodexTurnLease extends CoreSubscriptionTurnLease {
  constructor(deps: TurnCredentialLeaseDeps) {
    super(
      deps,
      { id: "codex", displayName: "Codex", ttlMs: CODEX_CREDENTIAL_LEASE_TTL_MS },
      {
        lostError: (reason) => new CodexCredentialLeaseLostError(reason),
        onLost: (reason) => {
          deps.observability.incrementCounter({
            name: "opengeni_codex_lease_renewals_total",
            help: "Codex lease renewal checkpoints by outcome and reason.",
            labels: { workspace_key: deps.codexWorkspaceKey, outcome: "lost", reason },
          });
          deps.observability.warn("Codex credential lease was lost during an active turn", {
            workspaceId: deps.workspaceId,
            turnId: deps.getTurnId(),
            reason,
          });
        },
        onRenewed: (reason) =>
          deps.observability.incrementCounter({
            name: "opengeni_codex_lease_renewals_total",
            help: "Codex lease renewal checkpoints by outcome and reason.",
            labels: { workspace_key: deps.codexWorkspaceKey, outcome: "completed", reason },
          }),
        onError: (error, reason) => {
          deps.observability.warn("Codex credential lease heartbeat failed", {
            workspaceId: deps.workspaceId,
            turnId: deps.getTurnId(),
            reason,
            ...safeErrorDiagnostic(error),
          });
          deps.observability.incrementCounter({
            name: "opengeni_codex_lease_renewals_total",
            help: "Codex lease renewal checkpoints by outcome and reason.",
            labels: { workspace_key: deps.codexWorkspaceKey, outcome: "error", reason },
          });
        },
      },
    );
  }
}

/** The legacy scoped-subscription lease callbacks (lost error, warnings) of one provider. */
function scopedLeaseCallbacks(
  deps: TurnCredentialLeaseDeps,
  provider: { name: string; code: string },
): LeaseCallbacks {
  return {
    lostError: (reason) =>
      Object.assign(
        new Error(provider.name + " credential lease is not usable for provider dispatch"),
        { code: provider.code, reason },
      ),
    onLost: (reason) =>
      deps.observability.warn(provider.name + " credential lease was lost during an active turn", {
        workspaceId: deps.workspaceId,
        turnId: deps.getTurnId(),
        reason,
      }),
    onError: (error) =>
      deps.observability.warn(provider.name + " credential lease heartbeat failed", {
        workspaceId: deps.workspaceId,
        turnId: deps.getTurnId(),
        ...safeErrorDiagnostic(error),
      }),
  };
}

/**
 * The SuperGrok credential holder: the legacy scoped lease keyed by subject
 * until the organization's SuperGrok cutover, the core turn lease (provider
 * `xai`) after core placement. Both modes keep the legacy lost error code
 * and warnings.
 */
export class XaiTurnLease extends CoreSubscriptionTurnLease {
  /** The legacy lease's subject; null on the core path. */
  subjectId: string | null = null;
  constructor(deps: TurnCredentialLeaseDeps) {
    super(
      deps,
      {
        id: "xai",
        displayName: "SuperGrok",
        ttlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
        legacyHeartbeat: ({ turnId, holderId, generation }) =>
          this.subjectId
            ? heartbeatXaiCredentialLeaseUntil(deps.db, {
                workspaceId: deps.workspaceId,
                subjectId: this.subjectId,
                turnId,
                holderId,
                generation,
                leaseTtlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
              })
            : Promise.resolve(null),
      },
      scopedLeaseCallbacks(deps, { name: "SuperGrok", code: "xai_credential_lease_lost" }),
    );
  }
}
/**
 * The Claude credential holder: the core turn lease (provider `claude`),
 * held only after core placement (the legacy Claude lease is deleted). It
 * keeps the legacy lost error code and warnings.
 */
export class ClaudeTurnLease extends CoreSubscriptionTurnLease {
  constructor(deps: TurnCredentialLeaseDeps) {
    super(
      deps,
      { id: "claude", displayName: "Claude", ttlMs: SUBSCRIPTION_CORE_CLAUDE_LEASE_TTL_MS },
      scopedLeaseCallbacks(deps, { name: "Claude", code: "claude_credential_lease_lost" }),
    );
  }
}

/** Serving-credential leases for one turn attempt plus their composite views. */
export type TurnCredentialLeases = {
  codex: CodexTurnLease;
  xai: XaiTurnLease;
  claude: ClaudeTurnLease;
  renewServing: (reason: LeaseRenewReason) => Promise<void>;
  servingLost: () => boolean;
};

export function createTurnCredentialLeases(deps: TurnCredentialLeaseDeps): TurnCredentialLeases {
  const codex = new CodexTurnLease(deps);
  const xai = new XaiTurnLease(deps);
  const claude = new ClaudeTurnLease(deps);
  return {
    codex,
    xai,
    claude,
    renewServing: async (reason) => {
      await codex.renew(reason);
      await xai.renew(reason);
      await claude.renew(reason);
    },
    servingLost: () => codex.lost || xai.lost || claude.lost,
  };
}
