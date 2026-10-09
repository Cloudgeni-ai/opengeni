/**
 * Read-only legacy adapter for the shared subscription core's shadow
 * comparison (design record docs/design/subscription-core-2026-10-07.md, step
 * M1). It builds the placement input of `@opengeni/subscriptions` for one
 * session and turn from today's Codex, Claude and SuperGrok tables, mapping
 * legacy shapes as design section 5.2 describes, so the worker can compare the
 * core's decision with the decision the legacy selector just made.
 *
 * Guarantees:
 * - One transaction of SELECT statements with a transaction-local statement
 *   timeout and no advisory locks; the adapter writes nothing. Codex worlds use
 *   a READ ONLY transaction. Claude and SuperGrok credential row security calls
 *   `<provider>_subscription_authority_live`, which records and removes its own
 *   transient capability row inside the policy function (exactly as every
 *   legacy read of those pools does), so those worlds cannot run READ ONLY.
 * - It runs only under the ambient session RLS actor of the turn (the same
 *   session-access rules as the turn itself) and never with an empty subject,
 *   so it cannot read a private session the turn could not read. The human it
 *   acts for comes only from that actor. A personal (user-scope)
 *   Claude/SuperGrok pool is read as that human, exactly like the legacy
 *   selector reads it; other pools never read personal rows.
 * - It starts no transaction or statement after `deadlineAt` or once `signal`
 *   aborts, and each statement is bounded by the statement timeout, capped at
 *   the time left when the transaction starts.
 * - Bounded: at most `LEGACY_WORLD_MAX_CONNECTIONS` connections per provider.
 * - It returns identifiers and policy facts only; credential material is
 *   never selected.
 */
import { sql, type SQL } from "drizzle-orm";
import { claudeSubscriptionCapacity } from "@opengeni/config";
import { ClaudeSubscriptionUsage, evaluateWorkspaceModelPolicy } from "@opengeni/contracts";
import type {
  CacheFacts,
  PersonalAuthority,
  PlacementInput,
  PlacementPerson,
  QuotaWindow,
  RotationSetting,
  SessionBinding,
  SubscriptionConnection,
  SubscriptionQuota,
} from "@opengeni/subscriptions";

import {
  currentSessionRlsActorInitiatingHumanSubjectId,
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  type Database,
} from "./database";

export type LegacySubscriptionProvider = "xai" | "claude";
export const LEGACY_SUBSCRIPTION_PROVIDERS: readonly LegacySubscriptionProvider[] = [
  "xai",
  "claude",
];
export const LEGACY_WORLD_MAX_CONNECTIONS = 64;
/** Opengeni's default Anthropic prompt-cache lifetime (`5m`). */
export const LEGACY_CLAUDE_CACHE_TTL_MS = 5 * 60_000;
const NEAR_EXHAUSTION_PERCENT = 90;

export type LegacyPlacementWorldRequest = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  provider: LegacySubscriptionProvider;
  /** The turn's accepted product model. */
  productModelId: string;
  /** Upstream model id (Claude cooldowns and windows are keyed by it). */
  upstreamModelId: string | null;
  reasoningLevel: string;
  /** Workspace model policy provider id of the product model (`policyProviderIdForModel`). */
  modelPolicyProviderId: string;
  /** Claude/SuperGrok: the turn's frozen pool scope. Null for Codex. */
  authorityScope: "workspace" | "organization" | "user" | null;
  now: Date;
  /** Upper bound for each statement; also bounded by the time left to `deadlineAt`. */
  statementTimeoutMs: number;
  /** Epoch ms after which no transaction or statement is started (the caller stopped waiting). */
  deadlineAt?: number;
  /** Aborting stops the read before its next statement. */
  signal?: AbortSignal;
  claudeCacheTtlMs?: number;
  /**
   * The session's pin and last account exactly as the legacy selector read
   * them before its own writes (it records the selected account and policy
   * pins before the shadow runs). When given, these are used instead of
   * re-reading the session, so would-switch compares against the state the
   * legacy decision was made from.
   */
  legacySession?: LegacySessionState;
};

export type LegacySessionState = {
  pinnedConnectionId: string | null;
  pinSource: string | null;
  lastConnectionId: string | null;
};

/** The caller's deadline passed before the read began. */
export class LegacyPlacementWorldDeadlineError extends Error {
  constructor() {
    super("legacy placement world deadline passed before the read began");
    this.name = "LegacyPlacementWorldDeadlineError";
  }
}

/**
 * The legacy selector's own inputs for this turn, which the Codex fleet shadow
 * does not record (inventory Part 3, answer (c)). Connection ids only.
 */
export type LegacyPlacementInputs = {
  /** The pool the legacy selector uses for this turn. */
  source: "workspace" | "organization" | "user" | "disabled";
  rotationEnabled: boolean | null;
  activeConnectionId: string | null;
  pin: { connectionId: string; source: "manual" | "policy" } | null;
  lastConnectionId: string | null;
  /** The legacy pool in its selection order (created_at, id). */
  poolOrder: string[];
  workspaceModelPolicy: "none" | "allows" | "excludes";
  lastModelCallAt: number | null;
  /** Connections read but beyond the bound. */
  truncated: boolean;
};

export type LegacyPlacementWorldResult =
  | { status: "loaded"; input: PlacementInput; legacy: LegacyPlacementInputs }
  | { status: "skipped"; reason: "no_session_actor" | "session_not_visible" };

type SessionRow = {
  visibility: string;
  owner_subject_id: string | null;
  codex_compaction_mode: string;
  workspace_kind: string | null;
  allowed_providers: string[] | null;
  allowed_models: string[] | null;
  has_model_policy: boolean;
  last_model_call_at: Date | string | null;
};

type PoolCredentialRow = {
  id: string;
  workspace_id: string | null;
  authority_scope: string;
  owner_organization_membership_id: string | null;
  status: string;
  allocator_enabled: boolean;
  allowed_model_ids: string[] | null;
  allowed_workspace_ids: string[] | null;
  allow_personal_workspaces: boolean;
  quota_used_percent: number | null;
  quota_reset_at: Date | string | null;
  quota_checked_at: Date | string | null;
  exhausted_until: Date | string | null;
  version: number;
  usage_snapshot: unknown;
  usage_model_cooldowns: Record<string, string> | null;
  usage_credential_version: number | null;
};

type RotationRow = {
  scope: string;
  active_credential_id: string | null;
  rotation_enabled: boolean;
};

type PinRow = {
  pinned_credential_id: string | null;
  pin_source: string | null;
  last_credential_id: string | null;
};

const POOL_TABLES = {
  xai: {
    credentials: sql.raw("xai_subscription_credentials"),
    rotation: sql.raw("xai_rotation_settings"),
    pins: sql.raw("xai_session_account_pins"),
  },
  claude: {
    credentials: sql.raw("claude_subscription_credentials"),
    rotation: sql.raw("claude_rotation_settings"),
    pins: sql.raw("claude_session_account_pins"),
  },
} as const;

function epoch(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function windowFor(
  id: string,
  usedPercent: number | null,
  resetsAt: number | null,
  observed: boolean,
): QuotaWindow {
  const status: QuotaWindow["status"] =
    !observed || usedPercent === null
      ? "unknown"
      : usedPercent >= 100
        ? "exhausted"
        : usedPercent >= NEAR_EXHAUSTION_PERCENT
          ? "warning"
          : "ok";
  return { id, usedPercent: observed ? usedPercent : null, resetsAt, status };
}

function healthOf(status: string): SubscriptionConnection["health"] {
  return status === "active" ? "healthy" : status === "needs_relogin" ? "needs_reconnect" : "error";
}

function rotationOf(row: RotationRow | undefined): RotationSetting | null {
  if (!row) return null;
  return row.rotation_enabled
    ? { mode: "spread" }
    : { mode: "primary_first", primaryConnectionId: row.active_credential_id };
}

function pinOf(pinnedId: string | null, pinSource: string | null): LegacyPlacementInputs["pin"] {
  if (!pinnedId) return null;
  // A pin without a recorded source is a manual pin (legacy classifyCodexPin).
  return { connectionId: pinnedId, source: pinSource === "policy" ? "policy" : "manual" };
}

/** Shared ownership/scope mapping of design section 5.2. */
function legacyOwnership(input: {
  row: {
    workspace_id: string | null;
    authority_scope: string;
    owner_organization_membership_id: string | null;
    allowed_workspace_ids: string[] | null;
    allow_personal_workspaces: boolean;
  };
  workspaceId: string;
  personalWorkspaceOwner: string | null;
  /** Owner of user-scope rows visible to this read, when known. */
  userScopeOwner: string | null;
  /** Codex `organization` mode: the workspace's own accounts are not assigned. */
  localAccountsUnassigned: boolean;
}): SubscriptionConnection["ownership"] {
  const { row } = input;
  if (row.authority_scope === "organization") {
    return {
      kind: "shared",
      managedByWorkspaceId: null,
      scope:
        row.allowed_workspace_ids === null
          ? { kind: "organization" }
          : {
              kind: "workspaces",
              workspaceIds: row.allowed_workspace_ids,
              allowPersonalWorkspaces: row.allow_personal_workspaces,
            },
    };
  }
  if (row.authority_scope === "user") {
    return {
      kind: "personal",
      ownerMembershipId:
        input.userScopeOwner ?? "membership:" + (row.owner_organization_membership_id ?? "unknown"),
    };
  }
  // Workspace scope: a Personal workspace's account belongs to its owner (D-18).
  if (input.personalWorkspaceOwner !== null) {
    return { kind: "personal", ownerMembershipId: input.personalWorkspaceOwner };
  }
  return {
    kind: "shared",
    managedByWorkspaceId: input.workspaceId,
    scope: {
      kind: "workspaces",
      workspaceIds: input.localAccountsUnassigned ? [] : [input.workspaceId],
      allowPersonalWorkspaces: false,
    },
  };
}

/**
 * Build the shared core's placement input for one session and turn from the
 * legacy tables. Returns `skipped` instead of reading when the caller has no
 * session RLS actor, and when the session is not visible to that actor.
 */
export async function loadLegacySubscriptionPlacementWorld(
  db: Database,
  request: LegacyPlacementWorldRequest,
): Promise<LegacyPlacementWorldResult> {
  // The turn's own session actor decides what is visible; the human it acts
  // for comes only from that actor, never from the caller.
  const human = currentSessionRlsActorInitiatingHumanSubjectId();
  if (human === undefined) return { status: "skipped", reason: "no_session_actor" };
  const deadlineAt = request.deadlineAt ?? Number.POSITIVE_INFINITY;
  const guard = () => {
    if (request.signal?.aborted || Date.now() > deadlineAt) {
      throw new LegacyPlacementWorldDeadlineError();
    }
  };
  // Never take a connection for a read nobody waits for.
  guard();
  const now = request.now.getTime();
  const timeoutMs = Math.max(1, Math.floor(request.statementTimeoutMs));
  return await withRlsContext(
    db,
    { accountId: request.accountId, workspaceId: request.workspaceId },
    async (scoped) => {
      guard();
      // No statement outlives the caller's deadline by more than this bound,
      // and no statement starts after it.
      const budgetMs = Math.max(1, Math.floor(Math.min(timeoutMs, deadlineAt - Date.now())));
      await scoped.execute(sql`select set_config('statement_timeout', ${`${budgetMs}ms`}, true)`);
      const read = async <T extends Record<string, unknown>>(query: SQL): Promise<T[]> => {
        guard();
        return await rawRows<T>(scoped, query);
      };
      const sessionRows = await read<SessionRow>(sql`
        select s.visibility, s.owner_subject_id, s.codex_compaction_mode,
          get_workspace_kind(${request.accountId}::uuid, ${request.workspaceId}::uuid)
            as workspace_kind,
          -- The workspace's own policy, else its organization's default.
          case when policy.workspace_id is not null then policy.allowed_providers
            else organization_defaults.allowed_providers end as allowed_providers,
          case when policy.workspace_id is not null then policy.allowed_models
            else organization_defaults.allowed_models end as allowed_models,
          (policy.workspace_id is not null
            or organization_defaults.allowed_providers is not null
            or organization_defaults.allowed_models is not null) as has_model_policy,
          (select max(fact.occurred_at) from model_call_facts fact
            where fact.workspace_id = ${request.workspaceId}::uuid
              and fact.session_id = s.id) as last_model_call_at
        from sessions s
        left join workspace_model_policies policy
          on policy.workspace_id = s.workspace_id
        left join organization_model_defaults organization_defaults
          on organization_defaults.account_id = s.account_id
        where s.workspace_id = ${request.workspaceId}::uuid
          and s.id = ${request.sessionId}::uuid
        limit 1
      `);
      const session = sessionRows[0];
      if (!session) return { status: "skipped", reason: "session_not_visible" } as const;

      const provider = request.provider;
      // Ownerless service sessions have no human authority to substitute.
      // Keep that fact explicit so people-scoped and personal connections stay
      // ineligible in both production placement and the shadow reference.
      const sessionOwner = session.owner_subject_id;
      const workspaceKind = session.workspace_kind === "personal" ? "personal" : "shared";
      // A Personal workspace has exactly one member, its owner, who owns its
      // sessions. A session without a recorded owner leaves the owner unknown:
      // its accounts then stay workspace accounts, as today, instead of being
      // attributed to an invented person.
      const personalWorkspaceOwner =
        workspaceKind === "personal" ? (session.owner_subject_id ?? null) : null;
      const lastModelCallAt = epoch(session.last_model_call_at);

      const modelPolicy: LegacyPlacementInputs["workspaceModelPolicy"] = !session.has_model_policy
        ? "none"
        : evaluateWorkspaceModelPolicy(
              {
                allowedProviders: session.allowed_providers,
                allowedModels: session.allowed_models,
              },
              { providerId: request.modelPolicyProviderId, modelId: request.productModelId },
            ).allowed
          ? "allows"
          : "excludes";

      let connections: SubscriptionConnection[] = [];
      let rotation: RotationSetting | null = null;
      let rotationRow: RotationRow | undefined;
      let source: LegacyPlacementInputs["source"];
      let pin: LegacyPlacementInputs["pin"] = null;
      let lastConnectionId: string | null = null;
      let poolOrder: string[] = [];
      let truncated = false;
      const providerSwitches: PlacementInput["settings"]["providers"] = {};
      let hasLocalAccounts = false;

      {
        const tables = POOL_TABLES[provider];
        const scope = request.authorityScope ?? "workspace";
        source = scope;
        // A user pool is read as its owner, the turn's human, exactly like the
        // legacy selector reads it; other pools never read personal rows
        // (their row security would also record a capability row per personal
        // credential). The initiating human stays set, so session visibility
        // is unchanged.
        const readsUserPool = scope === "user" && human !== null;
        if (readsUserPool) {
          guard();
          await setSubjectRlsContext(scoped, human);
        }
        const usageColumns =
          provider === "claude"
            ? sql`usage.snapshot as usage_snapshot, usage.model_cooldowns as usage_model_cooldowns,
                usage.credential_version as usage_credential_version`
            : sql`null::jsonb as usage_snapshot, null::jsonb as usage_model_cooldowns,
                null::integer as usage_credential_version`;
        const usageJoin =
          provider === "claude"
            ? sql`left join claude_subscription_account_usage usage on usage.credential_id = credential.id`
            : sql``;
        // Row security admits only the acting human's own personal rows (the
        // app role cannot read memberships to re-check owners); the co-member
        // test pins this.
        const rows = await read<PoolCredentialRow>(sql`
          select credential.id, credential.workspace_id, credential.authority_scope,
            credential.owner_organization_membership_id, credential.status,
            credential.allocator_enabled, credential.allowed_model_ids,
            credential.allowed_workspace_ids, credential.allow_personal_workspaces,
            credential.quota_used_percent, credential.quota_reset_at, credential.quota_checked_at,
            credential.exhausted_until, credential.version, ${usageColumns}
          from ${tables.credentials} credential
          ${usageJoin}
          where credential.account_id = ${request.accountId}::uuid
            and (credential.workspace_id = ${request.workspaceId}::uuid
              or (credential.authority_scope = 'organization' and credential.workspace_id is null))
            and (${readsUserPool} or credential.authority_scope <> 'user')
          order by credential.created_at, credential.id
          limit ${LEGACY_WORLD_MAX_CONNECTIONS + 1}
        `);
        truncated = rows.length > LEGACY_WORLD_MAX_CONNECTIONS;
        const bounded = rows.slice(0, LEGACY_WORLD_MAX_CONNECTIONS);
        hasLocalAccounts = bounded.some((row) => row.authority_scope === "workspace");
        poolOrder = bounded.filter((row) => row.authority_scope === scope).map((row) => row.id);
        const upstream = request.upstreamModelId ?? request.productModelId;
        connections = bounded.map((row) => {
          let quota: SubscriptionQuota | null = null;
          const exhaustedUntil = epoch(row.exhausted_until);
          const parsed =
            provider === "claude" && row.usage_credential_version === row.version
              ? ClaudeSubscriptionUsage.safeParse(row.usage_snapshot)
              : null;
          if (parsed?.success && parsed.data.credentialVersion === row.version) {
            const capacity = claudeSubscriptionCapacity(parsed.data, upstream, request.now);
            const cooldown = epoch(row.usage_model_cooldowns?.[upstream] ?? null);
            quota = {
              windows: [
                capacity.available
                  ? { id: "plan", usedPercent: null, resetsAt: null, status: "ok" }
                  : {
                      id: "plan",
                      usedPercent: null,
                      resetsAt: epoch(capacity.nextCheckAt),
                      status: "exhausted",
                    },
              ],
              modelCooldowns: cooldown === null ? {} : { [request.productModelId]: cooldown },
              exhaustedUntil: null,
              exhaustedKind: null,
              revision: 0,
              observedAt: now,
              observedRefreshGeneration: row.version,
              source: "response_headers",
            };
          } else if (provider === "xai" || exhaustedUntil !== null) {
            const observed = epoch(row.quota_checked_at) !== null;
            quota = {
              windows:
                provider === "xai"
                  ? [
                      windowFor(
                        "quota",
                        row.quota_used_percent,
                        epoch(row.quota_reset_at),
                        observed,
                      ),
                    ]
                  : [],
              modelCooldowns: {},
              exhaustedUntil,
              exhaustedKind: null,
              revision: 0,
              observedAt: epoch(row.quota_checked_at),
              observedRefreshGeneration: row.version,
              source: "usage_endpoint",
            };
          }
          return {
            id: row.id,
            provider,
            kind: "subscription",
            ownership: legacyOwnership({
              row,
              workspaceId: request.workspaceId,
              personalWorkspaceOwner,
              userScopeOwner: human,
              localAccountsUnassigned: false,
            }),
            health: healthOf(row.status),
            allocatorEnabled: row.allocator_enabled,
            entitledModelIds: null,
            excludedModelIds: [],
            allowedModelIds: row.allowed_model_ids,
            refreshGeneration: row.version,
            quota,
          };
        });
        const rotationRows = await read<RotationRow>(sql`
          select authority_scope as scope, active_credential_id, rotation_enabled
          from ${tables.rotation}
          where account_id = ${request.accountId}::uuid
            and ((workspace_id = ${request.workspaceId}::uuid and authority_scope = 'workspace')
              or (workspace_id is null and authority_scope = 'organization'))
        `);
        const workspaceRotation = rotationRows.find((row) => row.scope === "workspace");
        const organizationRotation = rotationRows.find((row) => row.scope === "organization");
        rotationRow =
          scope === "organization"
            ? organizationRotation
            : scope === "workspace"
              ? workspaceRotation
              : undefined;
        // A personal pool's rotation has no equivalent (design 5.2).
        rotation = rotationOf(
          scope === "user"
            ? hasLocalAccounts
              ? workspaceRotation
              : organizationRotation
            : rotationRow,
        );
        let poolSession = request.legacySession;
        if (!poolSession) {
          const [pinRow] = await read<PinRow>(sql`
            select pinned_credential_id, pin_source, last_credential_id
            from ${tables.pins}
            where workspace_id = ${request.workspaceId}::uuid
              and session_id = ${request.sessionId}::uuid
              and authority_scope = ${scope}
            order by updated_at desc
            limit 1
          `);
          poolSession = {
            pinnedConnectionId: pinRow?.pinned_credential_id ?? null,
            pinSource: pinRow?.pin_source ?? null,
            lastConnectionId: pinRow?.last_credential_id ?? null,
          };
        }
        pin = pinOf(poolSession.pinnedConnectionId, poolSession.pinSource);
        lastConnectionId = poolSession.lastConnectionId;
      }

      // Frozen personal authority (design 3.7): a user-scope snapshot for this
      // provider, and the Personal-workspace owner's own work, whose accounts
      // become their personal connections with fallback on (D-18).
      const personalAuthority: PersonalAuthority[] = [];
      if (
        sessionOwner !== null &&
        human &&
        (request.authorityScope === "user" || personalWorkspaceOwner === human)
      ) {
        personalAuthority.push({ provider, ownerMembershipId: human });
      }
      const people: PlacementPerson[] = sessionOwner
        ? [
            {
              membershipId: sessionOwner,
              active: true,
              personalFallbackOptIn: personalWorkspaceOwner === sessionOwner && hasLocalAccounts,
            },
          ]
        : [];
      if (human && human !== sessionOwner) {
        people.push({ membershipId: human, active: true, personalFallbackOptIn: false });
      }

      const bindingTarget = pin?.connectionId ?? lastConnectionId;
      const bound = bindingTarget
        ? connections.find((connection) => connection.id === bindingTarget)
        : undefined;
      const binding: SessionBinding | null = bindingTarget
        ? {
            connectionId: bindingTarget,
            provider: bound?.provider ?? provider,
            modelId: request.productModelId,
            choice: pin?.source === "manual" ? "explicit" : "automatic",
            lastModelCallAt: lastModelCallAt ?? 0,
          }
        : null;
      const cacheFacts: Record<string, CacheFacts> = {
        codex: { kind: "measured_idle_cutoff", cutoffMs: null },
        xai: { kind: "measured_idle_cutoff", cutoffMs: null },
        claude: {
          kind: "exact_ttl",
          ttlMs: request.claudeCacheTtlMs ?? LEGACY_CLAUDE_CACHE_TTL_MS,
        },
      };
      const input: PlacementInput = {
        now,
        workspace: {
          id: request.workspaceId,
          kind: workspaceKind,
          ownerMembershipId: personalWorkspaceOwner,
          allowedModelIds:
            modelPolicy === "none"
              ? null
              : modelPolicy === "allows"
                ? [request.productModelId]
                : [],
        },
        session: {
          id: request.sessionId,
          workspaceId: request.workspaceId,
          visibility: session.visibility === "workspace_shared" ? "shared" : "private",
          ownerMembershipId: sessionOwner,
          preferredModelId: request.productModelId,
          reasoningLevel: request.reasoningLevel,
          binding,
          onlyThisModel: false,
          reselectionPoints: [],
          personalAuthority,
          compactionProviderLock: session.codex_compaction_mode === "remote_v2" ? "codex" : null,
        },
        settings: {
          rotation: rotation ? { [provider]: rotation } : {},
          providers: providerSwitches,
          crossProviderFailover: false,
          fallbackOrder: {},
          personalConnectionsAllowed: true,
          personalFallbackAllowed: true,
        },
        people,
        models: [
          {
            id: request.productModelId,
            provider,
            reasoningLevels: [request.reasoningLevel],
          },
        ],
        connections,
        cacheFacts,
      };
      return {
        status: "loaded",
        input,
        legacy: {
          source,
          rotationEnabled: rotationRow ? rotationRow.rotation_enabled : null,
          activeConnectionId: rotationRow?.active_credential_id ?? null,
          pin,
          lastConnectionId,
          poolOrder,
          workspaceModelPolicy: modelPolicy,
          lastModelCallAt,
          truncated,
        },
      } as const;
    },
    undefined,
    "none",
  );
}
