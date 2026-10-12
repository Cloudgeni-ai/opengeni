/**
 * A person's explicit account choice for a session and their own personal
 * preferences on the shared subscription core, for every registered
 * provider (design 4.5 and "M5: personal accounts and explicit choice";
 * contract SUB-SEL-02, SUB-SEL-04, SUB-ELIG-05, SUB-OWN-05, D-24, D-27 and
 * D-28).
 *
 * - `readSubscriptionCoreSessionAccountChoice`: what the model picker may
 *   offer for one session: the shared connections of the workspace's pool
 *   and the caller's own personal connections (never another person's),
 *   each with whether this session may choose it, plus the session's
 *   current choice and the effective personal settings.
 * - `chooseSubscriptionCoreSessionAccount`: makes the session's binding
 *   `explicit` on one connection, or returns it to automatic placement. The
 *   provider is the chosen connection's, found through the registry; the
 *   binding guard in the database decides whether this session may use it
 *   (an active connection; a personal one only for its owner, in their
 *   private session or Personal workspace, while personal connections are
 *   allowed there).
 * - `readSubscriptionPersonPreferences` / `writeSubscriptionPersonPreferences`:
 *   the caller's own personal-fallback opt-in, through the owner policies
 *   of migration 0729. Placement reads the opt-in only for the session
 *   owner and only while the effective `personalFallbackAllowed` setting
 *   admits fallback.
 *
 * Nothing here returns credential material, and no provider is named: the
 * registry supplies every provider binding as data.
 */
import { and, eq, sql } from "drizzle-orm";
import type { SessionEvent, SessionEventType } from "@opengeni/contracts";
import * as schema from "../schema";
import {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
} from "../database";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "../lossless-json";
import { lockSessionEventWriteRows } from "../session-control";
import {
  readSubscriptionEffectiveSettings,
  readSubscriptionProviderCutoverState,
  resolveSubscriptionConnectionId,
  isSubscriptionSessionBindingRollingConflict,
  writeSubscriptionSessionBinding,
} from "../subscription-core-repository";
import {
  subscriptionCoreProvider,
  subscriptionCoreProviderIds,
} from "../subscription-core-providers";
import { subscriptionCoreProviderId, type SubscriptionCoreProvider } from "./provider";
import {
  projectSubscriptionCoreAccountUsage,
  type SubscriptionCoreAccountUsage,
} from "./account-usage-presentation";
import {
  listSubscriptionCorePersonalConnectionRowsInTransaction,
  readSubscriptionCoreWorkspacePool,
  subscriptionCoreWakeReason,
  type SubscriptionCoreConnectionRow,
  type SubscriptionCoreWake,
} from "./administration";

/** The neutral session event a choice change records. */
export const SUBSCRIPTION_CORE_ACCOUNT_CHOICE_EVENT =
  "model_account.selection.changed" satisfies SessionEventType;

/** Why the picker cannot offer a listed connection for this session. */
export type SubscriptionCoreAccountChoiceRefusal =
  /** The connection cannot serve (reconnect needed, revoked, disabled). */
  | "inactive"
  /** Personal connections are not allowed in this workspace. */
  | "personal_not_allowed"
  /** A personal connection serves only its owner's private sessions and Personal workspace. */
  | "personal_not_owner_work"
  /**
   * The session has no owner (for example a run of a schedule created with an
   * API key): the binding guard admits no explicit choice for it.
   */
  | "session_has_no_owner";

export type SubscriptionCoreChoosableConnection = {
  provider: string;
  connectionId: string;
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  status: string;
  /** The caller's own personal connection (never another person's). */
  personal: boolean;
  /** For a shared connection, the workspace pool it belongs to. */
  source: "workspace" | "organization" | "personal";
  allowedModelIds: string[] | null;
  choosable: boolean;
  refusal: SubscriptionCoreAccountChoiceRefusal | null;
  /** Cached observation for this already-visible account; never an eligibility decision. */
  usage: SubscriptionCoreAccountUsage | null;
};

export type SubscriptionCoreSessionAccountChoice = {
  /**
   * The session's binding when it has exactly one: `explicit` after a
   * person's choice, else the account automatic placement last used. Null
   * when it has none, or bindings for several providers (see `bindings`).
   * The connection is withheld (null) unless the caller may see it in the
   * list.
   */
  binding: SubscriptionCoreSessionChoiceBinding | null;
  /**
   * Every binding of the session, one per provider (D-32), ordered by
   * provider, with the same connection withholding.
   */
  bindings: SubscriptionCoreSessionChoiceBinding[];
  connections: SubscriptionCoreChoosableConnection[];
  personal: {
    /** Effective `personalConnectionsAllowed` for this workspace. */
    connectionsAllowed: boolean;
    /** Effective `personalFallbackAllowed` for this workspace. */
    fallbackAllowed: boolean;
    /** The caller's own opt-in (fallback needs it and the setting). */
    fallbackOptIn: boolean;
  };
};

export type SubscriptionCoreSessionChoiceBinding = {
  provider: string;
  connectionId: string | null;
  choice: "explicit" | "automatic";
};

type SessionFacts = {
  ownerSubjectId: string | null;
  visibility: string;
  workspaceKind: "personal" | "shared";
};

function choiceRefusal(
  row: SubscriptionCoreConnectionRow,
  personal: boolean,
  session: SessionFacts,
  subjectId: string,
  connectionsAllowed: boolean,
): SubscriptionCoreAccountChoiceRefusal | null {
  if (row.status !== "active") return "inactive";
  // The binding guard refuses every explicit choice for an ownerless session.
  if (session.ownerSubjectId === null) return "session_has_no_owner";
  if (!personal) return null;
  if (!connectionsAllowed) return "personal_not_allowed";
  const ownersWork =
    session.ownerSubjectId === subjectId &&
    (session.visibility === "user_private" || session.workspaceKind === "personal");
  return ownersWork ? null : "personal_not_owner_work";
}

async function readSessionFacts(
  tx: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<SessionFacts | null> {
  const [row] = await rawRows<{
    owner_subject_id: string | null;
    visibility: string;
    workspace_kind: string | null;
  }>(
    tx,
    sql`select session.owner_subject_id, session.visibility,
        get_workspace_kind(session.account_id, session.workspace_id) as workspace_kind
      from sessions session
      where session.account_id = ${input.accountId}::uuid
        and session.workspace_id = ${input.workspaceId}::uuid
        and session.id = ${input.sessionId}::uuid`,
  );
  if (!row) return null;
  return {
    ownerSubjectId: row.owner_subject_id,
    visibility: row.visibility,
    workspaceKind: row.workspace_kind === "personal" ? "personal" : "shared",
  };
}

/**
 * The provider bindings a choice ranges over: every registered provider, or
 * the bindings a caller passes (a test registration of its own provider).
 */
export type SubscriptionCoreChoiceProviders = readonly SubscriptionCoreProvider[];

function registeredProviders(): SubscriptionCoreChoiceProviders {
  return subscriptionCoreProviderIds().map((providerId) => subscriptionCoreProvider(providerId));
}

/** The providers whose cutover is enabled for the organization, in the given order. */
async function enabledProviders(
  tx: Database,
  accountId: string,
  providers: SubscriptionCoreChoiceProviders,
): Promise<SubscriptionCoreProvider[]> {
  const enabled: SubscriptionCoreProvider[] = [];
  for (const binding of providers) {
    const state = await readSubscriptionProviderCutoverState(tx, {
      accountId,
      provider: subscriptionCoreProviderId(binding),
    });
    if (state === "enabled") enabled.push(binding);
  }
  return enabled;
}

/**
 * Every connection this caller could name for the session: the pool's shared
 * connections and the caller's own personal ones, per enabled provider.
 * Requires the workspace RLS context on `tx`; sets the subject.
 */
async function listChoosableConnections(
  tx: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
  session: SessionFacts,
  connectionsAllowed: boolean,
  providers: SubscriptionCoreChoiceProviders,
): Promise<SubscriptionCoreChoosableConnection[]> {
  const connections: SubscriptionCoreChoosableConnection[] = [];
  for (const binding of await enabledProviders(tx, input.accountId, providers)) {
    const providerId = binding.adapter.provider;
    const pool = await readSubscriptionCoreWorkspacePool(tx, binding, input);
    const listed = new Set<string>();
    const add = (
      row: SubscriptionCoreConnectionRow,
      source: SubscriptionCoreChoosableConnection["source"],
    ) => {
      if (listed.has(row.id)) return;
      listed.add(row.id);
      const personal = source === "personal";
      const refusal = choiceRefusal(row, personal, session, input.subjectId, connectionsAllowed);
      connections.push({
        provider: providerId,
        connectionId: row.id,
        label: row.label,
        accountEmail: row.account_email,
        planType: row.plan_type,
        status: row.status,
        personal,
        source,
        allowedModelIds: row.allowed_model_ids,
        choosable: refusal === null,
        refusal,
        usage: projectSubscriptionCoreAccountUsage(row),
      });
    };
    // A provider switched off for the workspace offers nothing, shared or
    // personal: its turns wait as `model_not_allowed` whatever is chosen.
    if (pool.source.effectiveSource === "disabled") continue;
    for (const entry of pool.connections) add(entry.row, entry.source);
    // Only human subjects own personal connections; the reader returns
    // nothing for anyone else.
    for (const row of await listSubscriptionCorePersonalConnectionRowsInTransaction(
      tx,
      binding,
      input,
    )) {
      add(row, "personal");
    }
  }
  return connections;
}

async function readOwnOptIn(
  tx: Database,
  input: { accountId: string; subjectId: string },
  options: { lock?: boolean } = {},
): Promise<{ membershipId: string; optIn: boolean; version: number } | null> {
  if (!input.subjectId.startsWith("user:")) return null;
  const [membership] = await rawRows<{ id: string | null }>(
    tx,
    // Runtime roles cannot read organization_memberships; this routine
    // answers only with the caller's own active human membership.
    sql`select opengeni_private.subscription_own_person_membership_id(${input.accountId}::uuid)::text as id`,
  );
  if (!membership?.id) return null;
  const [preference] = await rawRows<{
    personal_fallback_opt_in: boolean;
    version: number | string;
  }>(
    tx,
    sql`select personal_fallback_opt_in, version from subscription_person_preferences
      where account_id = ${input.accountId}::uuid
        and organization_membership_id = ${membership.id}::uuid
      ${options.lock ? sql`for update` : sql``}`,
  );
  return {
    membershipId: membership.id,
    optIn: preference?.personal_fallback_opt_in ?? false,
    version: preference ? Number(preference.version) : 0,
  };
}

/**
 * What the model picker may offer for this session, for the calling
 * subject. Null when the session is not visible to the caller.
 */
export async function readSubscriptionCoreSessionAccountChoice(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; subjectId: string },
  providers: SubscriptionCoreChoiceProviders = registeredProviders(),
): Promise<SubscriptionCoreSessionAccountChoice | null> {
  return await withWorkspaceSubjectSessionActivityRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) => {
      const tx = scopedDb as unknown as Database;
      const session = await readSessionFacts(tx, input);
      if (!session) return null;
      const effective = await readSubscriptionEffectiveSettings(
        tx,
        input.accountId,
        input.workspaceId,
      );
      const connectionsAllowed = effective.values.personalConnectionsAllowed === true;
      const connections = await listChoosableConnections(
        tx,
        input,
        session,
        connectionsAllowed,
        providers,
      );
      await setSubjectRlsContext(tx, input.subjectId);
      const stored = await rawRows<{
        provider: string;
        connection_id: string | null;
        choice: string;
      }>(
        tx,
        sql`select provider, connection_id::text as connection_id, choice
          from subscription_session_bindings
          where account_id = ${input.accountId}::uuid
            and workspace_id = ${input.workspaceId}::uuid
            and session_id = ${input.sessionId}::uuid
          order by provider`,
      );
      const optIn = await readOwnOptIn(tx, input);
      const bindings = stored.map(
        (binding): SubscriptionCoreSessionChoiceBinding => ({
          provider: binding.provider,
          connectionId: connections.some(
            (connection) =>
              connection.provider === binding.provider &&
              connection.connectionId === binding.connection_id,
          )
            ? binding.connection_id
            : null,
          choice: binding.choice === "explicit" ? "explicit" : "automatic",
        }),
      );
      return {
        binding: bindings.length === 1 ? bindings[0]! : null,
        bindings,
        connections,
        personal: {
          connectionsAllowed,
          fallbackAllowed: effective.values.personalFallbackAllowed === true,
          fallbackOptIn: optIn?.optIn ?? false,
        },
      };
    },
  );
}

/** A wake for one provider's waiters of the chosen session, delivered after commit. */
export type SubscriptionCoreProviderWake = SubscriptionCoreWake & { provider: string };

export type SubscriptionCoreSessionChoiceOutcome =
  /** The binding changed; `events` holds the recorded event. */
  | "changed"
  /** The session already had exactly this choice. */
  | "unchanged"
  /** No such session, or no connection of that id this caller may name. */
  | "not_found"
  /** The database refused the connection for this session (binding guard). */
  | "refused"
  /**
   * The choice could not be applied for now: the transaction kept losing a
   * deadlock to a concurrent placement after its bounded replay (the binding
   * is locked before its version is compared, so a lost compare-and-swap is
   * defensive only). Nothing changed; the client may retry.
   */
  | "conflict";

export type SubscriptionCoreSessionChoiceResult = {
  outcome: SubscriptionCoreSessionChoiceOutcome;
  appliedTo: "waiting_turn" | "next_turn";
  provider: string | null;
  connectionId: string | null;
  events: SessionEvent[];
  wakes: SubscriptionCoreProviderWake[];
};

function mapSessionEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEventType,
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
    turnGeneration: row.turnGeneration,
    turnAttemptId: row.turnAttemptId,
    turnAssociation: row.turnAssociation as SessionEvent["turnAssociation"],
    duplicateOfEventId: row.duplicateOfEventId,
    duplicateReason: row.duplicateReason,
  };
}

function postgresErrorCode(error: unknown): unknown {
  return (
    (error as { code?: unknown } | null)?.code ??
    (error as { cause?: { code?: unknown } } | null)?.cause?.code
  );
}

/**
 * Make the session's account choice explicit on `connectionId` (any
 * registered provider's connection the caller may name: a shared connection
 * of the workspace's pool or the caller's own personal connection), or
 * return it to automatic placement (`null`). The binding guard enforces
 * eligibility; a running attempt keeps its account and a waiting turn
 * re-places at its next check, which the returned wakes trigger. A choice
 * of an account that cannot serve the session's model is recorded and waits
 * as `pinned_account_ineligible` (D-24).
 */
export async function chooseSubscriptionCoreSessionAccount(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    connectionId: string | null;
    subjectId: string;
    /**
     * With `connectionId: null`, return only this provider's choice to
     * automatic; without it, every provider's. With a connection, it must
     * be that connection's provider.
     */
    provider?: string | null;
  },
  providers: SubscriptionCoreChoiceProviders = registeredProviders(),
): Promise<SubscriptionCoreSessionChoiceResult> {
  // A choice locks the session row, then the binding, then (through the
  // binding's disconnect-admission trigger) the chosen connection's refresh
  // lock. A session's first placement takes that refresh lock before it
  // locks the binding it inserts, so the two can close a cycle. PostgreSQL
  // aborts one side with 40P01 and every effect of the aborted choice rolls
  // back, so replaying the whole transaction is exact. The replay stays
  // outside the transaction it repeats.
  const maxAttempts = 3;
  const requested =
    input.connectionId !== null && UUID_PATTERN.test(input.connectionId)
      ? input.connectionId.toLowerCase()
      : input.connectionId;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await chooseOnce(db, { ...input, connectionId: requested }, providers);
    } catch (error) {
      if (postgresErrorCode(error) !== "40P01") throw error;
      if (attempt >= maxAttempts) {
        return {
          outcome: "conflict",
          appliedTo: "next_turn",
          provider: null,
          connectionId: null,
          events: [],
          wakes: [],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

/** A defensive lost compare-and-swap inside a choice's savepoint (rolls it back). */
class LostSessionChoice extends Error {}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function chooseOnce(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    connectionId: string | null;
    subjectId: string;
    provider?: string | null;
  },
  providers: SubscriptionCoreChoiceProviders,
): Promise<SubscriptionCoreSessionChoiceResult> {
  const none = (
    outcome: SubscriptionCoreSessionChoiceOutcome,
  ): SubscriptionCoreSessionChoiceResult => ({
    outcome,
    appliedTo: "next_turn",
    provider: null,
    connectionId: null,
    events: [],
    wakes: [],
  });
  return await withWorkspaceSubjectSessionActivityRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) => {
      const tx = scopedDb as unknown as Database;
      const facts = await readSessionFacts(tx, input);
      if (!facts) return none("not_found");

      // Resolve the named connection to its provider and canonical id among
      // the connections this caller may name, before any lock is taken.
      let target: { provider: string; connectionId: string } | null = null;
      if (input.connectionId !== null) {
        const effective = await readSubscriptionEffectiveSettings(
          tx,
          input.accountId,
          input.workspaceId,
        );
        const candidates = await listChoosableConnections(
          tx,
          input,
          facts,
          effective.values.personalConnectionsAllowed === true,
          providers,
        );
        for (const providerId of new Set(candidates.map((candidate) => candidate.provider))) {
          // A legacy alias names its canonical connection (shared rows only;
          // personal rows are listed by their canonical ids).
          const canonical =
            (await resolveSubscriptionConnectionId(tx, {
              accountId: input.accountId,
              provider: providerId,
              connectionId: input.connectionId,
            })) ?? input.connectionId;
          const match = candidates.find(
            (candidate) =>
              candidate.provider === providerId && candidate.connectionId === canonical,
          );
          if (match) {
            target = { provider: providerId, connectionId: match.connectionId };
            break;
          }
        }
        if (!target) return none("not_found");
        if (input.provider != null && input.provider !== target.provider) return none("not_found");
      }
      // The binding guard requires an initiating subject for every binding
      // write and uses it only to match a personal account's owner, so the
      // choosing subject is recorded whoever it is (as the existing provider
      // pin does):
      // an API key or service may choose a shared account, and never matches
      // a personal owner.
      await setSubjectRlsContext(tx, input.subjectId);
      await tx.execute(
        sql`select set_config('opengeni.initiating_human_subject_id', ${input.subjectId}, true)`,
      );
      // A preference change admits no inference, so the canonical
      // session-events lock is taken without the workspace control prefix
      // (the same lock contract as every pin).
      const locks = await lockSessionEventWriteRows(tx, {
        workspaceId: input.workspaceId,
        controlLock: "none",
        sessionIds: [input.sessionId],
        sessionLock: "no_key_update",
      });
      const session = locks.sessions.find((row) => row.id === input.sessionId);
      if (!session || session.accountId !== input.accountId) return none("not_found");

      // A session keeps one binding per provider (D-32). A choice locks and
      // writes only the chosen connection's provider row and never changes a
      // row's provider, so another provider's choice stays exactly as stored.
      // A return to automatic changes only explicit rows: the named
      // provider's, or without one every provider's (the whole session).
      const resetProvider = target === null ? (input.provider ?? null) : null;
      let touched: string[] = [];
      let written = false;
      // An absent binding can be inserted by a concurrent placement between
      // our read and our insert; the retry then finds and locks that row.
      for (let attempt = 0; attempt < 3 && !written; attempt += 1) {
        // Lock the rows so a running turn's placement cannot advance their
        // version between this read and the compare-and-swap below.
        const locked = await rawRows<{
          provider: string;
          connection_id: string | null;
          choice: string;
          version: number | string;
        }>(
          tx,
          sql`select provider, connection_id::text as connection_id, choice, version
            from subscription_session_bindings
            where workspace_id = ${input.workspaceId}::uuid
              and session_id = ${input.sessionId}::uuid
              and ${
                target !== null
                  ? sql`provider = ${target.provider}`
                  : resetProvider !== null
                    ? sql`provider = ${resetProvider} and choice = 'explicit'`
                    : sql`choice = 'explicit'`
              }
            order by provider
            for update`,
        );
        if (target === null) {
          if (locked.length === 0) return none("unchanged");
          touched = locked.map((row) => row.provider);
        } else {
          const own = locked[0];
          if (own && own.choice === "explicit" && own.connection_id === target.connectionId) {
            return {
              ...none("unchanged"),
              provider: target.provider,
              connectionId: target.connectionId,
            };
          }
          touched = [target.provider];
        }
        try {
          written = await tx.transaction(async (savepoint) => {
            const scoped = savepoint as unknown as Database;
            if (target === null) {
              // Only the choice changes: the connection guard (which needs an
              // active connection) is not run for a return to automatic.
              for (const row of locked) {
                const rows = await rawRows<{ version: number | string }>(
                  scoped,
                  sql`update subscription_session_bindings
                    set choice = 'automatic', version = version + 1
                    where workspace_id = ${input.workspaceId}::uuid
                      and session_id = ${input.sessionId}::uuid
                      and provider = ${row.provider}
                      and version = ${Number(row.version)}
                    returning version`,
                );
                // Defensive (the rows are locked): undo every change.
                if (rows.length === 0) throw new LostSessionChoice();
              }
              return true;
            }
            const own = locked[0];
            if (own) {
              const rows = await rawRows<{ version: number | string }>(
                scoped,
                sql`update subscription_session_bindings
                  set connection_id = ${target.connectionId}::uuid,
                      choice = 'explicit', last_switch_reason = 'explicit_choice',
                      version = version + 1
                  where workspace_id = ${input.workspaceId}::uuid
                    and session_id = ${input.sessionId}::uuid
                    and provider = ${target.provider}
                    and version = ${Number(own.version)}
                  returning version`,
              );
              return rows.length > 0;
            }
            const version = await writeSubscriptionSessionBinding(scoped, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              provider: target.provider,
              connectionId: target.connectionId,
              modelId: session.model,
              choice: "explicit",
              onlyThisModel: false,
              lastModelCallAt: null,
              lastSwitchReason: "explicit_choice",
            });
            return version !== null;
          });
        } catch (error) {
          // The guard refuses a connection this session may not use.
          if (postgresErrorCode(error) === "42501") {
            return { ...none("refused"), provider: target?.provider ?? null };
          }
          // A lost compare-and-swap, or a racing first binding that met
          // 0733's rolling index: the savepoint rolled back; retry.
          if (error instanceof LostSessionChoice) continue;
          if (isSubscriptionSessionBindingRollingConflict(error)) continue;
          throw error;
        }
      }
      if (!written) return none("conflict");
      const changedProvider = target?.provider ?? (touched.length === 1 ? touched[0]! : null);

      const appliedTo: "waiting_turn" | "next_turn" =
        session.status === "waiting_capacity" && session.activeTurnId
          ? "waiting_turn"
          : "next_turn";
      const inserted = await tx
        .insert(schema.sessionEvents)
        .values(
          withLosslessContentWriteVersion(
            [
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                sequence: session.lastSequence + 1,
                type: SUBSCRIPTION_CORE_ACCOUNT_CHOICE_EVENT,
                payload: {
                  provider: changedProvider,
                  providers: touched,
                  connectionId: target?.connectionId ?? null,
                  choice: target ? "explicit" : "automatic",
                  appliedTo,
                  turnId: appliedTo === "waiting_turn" ? session.activeTurnId : null,
                  subjectId: input.subjectId,
                },
                occurredAt: new Date(),
              },
            ],
            "payload",
            "payloadCodecVersion",
          ),
        )
        .returning();
      await tx
        .update(schema.sessions)
        .set({ lastSequence: session.lastSequence + 1, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      // Wake this session's waiters of the providers the choice touched: a
      // choice changes nothing another session can place on.
      return {
        outcome: "changed",
        appliedTo,
        provider: changedProvider,
        connectionId: target?.connectionId ?? null,
        events: inserted.map(mapSessionEvent),
        wakes: touched.flatMap((providerId) => {
          const binding = providers.find((each) => each.adapter.provider === providerId);
          return binding
            ? [
                {
                  provider: providerId,
                  accountId: input.accountId,
                  reason: subscriptionCoreWakeReason(binding, "session_choice_changed"),
                  workspaceIds: [input.workspaceId],
                  sessionIds: [input.sessionId],
                },
              ]
            : [];
        }),
      };
    },
  );
}

export type SubscriptionPersonPreferences = {
  personalFallbackOptIn: boolean;
  /** 0 before the person ever saved a preference. */
  version: number;
};

/**
 * The caller's own preferences in this organization. Null for anyone who is
 * not an active human member (agents and service actors have none).
 */
export async function readSubscriptionPersonPreferences(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<SubscriptionPersonPreferences | null> {
  if (!input.subjectId.startsWith("user:")) return null;
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, input.subjectId);
    const own = await readOwnOptIn(tx, input);
    return own ? { personalFallbackOptIn: own.optIn, version: own.version } : null;
  });
}

/**
 * Save the caller's own personal-fallback opt-in. `expectedVersion`
 * (optional) is the version last read: 0 for no saved preference. A stale
 * version is a `conflict` and changes nothing.
 */
export async function writeSubscriptionPersonPreferences(
  db: Database,
  input: {
    accountId: string;
    subjectId: string;
    personalFallbackOptIn: boolean;
    expectedVersion?: number;
  },
  providers: SubscriptionCoreChoiceProviders = registeredProviders(),
): Promise<
  | {
      outcome: "written";
      preferences: SubscriptionPersonPreferences;
      /**
       * Capacity wakes to deliver after commit: turning the opt-in on can
       * make the person's own account eligible for a waiting turn. Turning
       * it off wakes nothing (D-27: no forced move).
       */
      wakes: SubscriptionCoreProviderWake[];
    }
  | { outcome: "conflict"; preferences: SubscriptionPersonPreferences }
  | { outcome: "not_member" }
> {
  const expected = input.expectedVersion;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
    throw new Error("A preference expected version must be a non-negative safe integer");
  }
  if (!input.subjectId.startsWith("user:")) return { outcome: "not_member" };
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, input.subjectId);
    // Lock the row so the value the wake decision compares against is the
    // one this write replaces, even against a concurrent write of the same
    // row (another tab).
    const own = await readOwnOptIn(tx, input, { lock: true });
    if (!own) return { outcome: "not_member" as const };
    const value = input.personalFallbackOptIn;
    const rows = await rawRows<{ personal_fallback_opt_in: boolean; version: number | string }>(
      tx,
      expected === 0
        ? sql`insert into subscription_person_preferences
              (account_id, organization_membership_id, personal_fallback_opt_in, updated_at)
            values (${input.accountId}::uuid, ${own.membershipId}::uuid, ${value}, now())
            on conflict (account_id, organization_membership_id) do nothing
            returning personal_fallback_opt_in, version`
        : expected !== undefined
          ? sql`update subscription_person_preferences
              set personal_fallback_opt_in = ${value}, version = version + 1, updated_at = now()
              where account_id = ${input.accountId}::uuid
                and organization_membership_id = ${own.membershipId}::uuid
                and version = ${expected}
              returning personal_fallback_opt_in, version`
          : sql`insert into subscription_person_preferences
              (account_id, organization_membership_id, personal_fallback_opt_in, updated_at)
            values (${input.accountId}::uuid, ${own.membershipId}::uuid, ${value}, now())
            on conflict (account_id, organization_membership_id) do update
              set personal_fallback_opt_in = excluded.personal_fallback_opt_in,
                  version = subscription_person_preferences.version + 1,
                  updated_at = excluded.updated_at
            returning personal_fallback_opt_in, version`,
    );
    const [row] = rows;
    if (!row) {
      const current = await readOwnOptIn(tx, input);
      return {
        outcome: "conflict" as const,
        preferences: {
          personalFallbackOptIn: current?.optIn ?? false,
          version: current?.version ?? 0,
        },
      };
    }
    // Wake the person's own waiting turns of every provider on the core when
    // the opt-in turns on. Placement offers a personal account only to
    // sessions its owner owns, so no other session can place differently.
    const wakes: SubscriptionCoreProviderWake[] =
      row.personal_fallback_opt_in && !own.optIn
        ? (await enabledProviders(tx, input.accountId, providers)).map((binding) => ({
            provider: binding.adapter.provider,
            accountId: input.accountId,
            reason: subscriptionCoreWakeReason(binding, "person_preferences_changed"),
            ownerMembershipId: own.membershipId,
          }))
        : [];
    return {
      outcome: "written" as const,
      preferences: {
        personalFallbackOptIn: row.personal_fallback_opt_in,
        version: Number(row.version),
      },
      wakes,
    };
  });
}
