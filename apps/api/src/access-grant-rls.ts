import type { AccessGrant } from "@opengeni/contracts";
import {
  requireLiveAgentAttemptAuthorization,
  SessionAuthorizationDeniedError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  freezeAgentLearningPolicy,
  withSessionRlsActorContext,
  withCreditDebitAttribution,
  type CreditDebitAttribution,
  currentCreditDebitAttribution,
} from "@opengeni/db";
import { ApiHttpError } from "./http/api-error";

const AGENT_ATTEMPT_AUTHORITY_INVALID = "agent attempt authority is invalid";

/**
 * A refused agent-attempt credential. The detail code names why, so request
 * telemetry can tell a process that outlived its turn (`caller_stale`) from a
 * malformed or revoked credential instead of reporting it as unclassified.
 */
function agentAttemptAuthorityError(
  reason: "malformed" | SessionAuthorizationDeniedError["reason"],
  cause?: unknown,
): ApiHttpError {
  const error = new ApiHttpError(403, {
    code: "forbidden",
    message: AGENT_ATTEMPT_AUTHORITY_INVALID,
    retryable: false,
    outcomeUnknown: false,
    details: { code: `agent_attempt_${reason}` },
  });
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Trusted payer for a non-agent grant: an authenticated human session pays as
 * that human; keys and services are service work. An agent attempt must be
 * resolved through the validated middleware context installed below.
 */
export function creditDebitAttributionForGrant(grant: AccessGrant): CreditDebitAttribution {
  if (grant.principalKind === "agent_attempt") return currentCreditDebitAttribution();
  return grant.principalKind === "human_session"
    ? { kind: "human", initiatingHumanSubjectId: grant.subjectId }
    : ["service", "api_key", "configured_key", "mcp_gateway"].includes(grant.principalKind ?? "")
      ? { kind: "service" }
      : { kind: "unknown" };
}

/**
 * Start `work` alongside an authorization `gate` instead of after it, so a
 * request pays one database wait for both. The gate still decides: when it
 * refuses, its error is the answer and `work`'s result or failure is dropped
 * unread. Only use this for reads whose result is disclosed after the gate.
 */
export async function alongsideAuthorization<G, W>(
  gate: Promise<G>,
  work: () => Promise<W>,
): Promise<[G, W]> {
  const pending = work();
  // Observed here so a refused gate never leaves an unhandled rejection.
  pending.catch(() => undefined);
  const decided = await gate;
  return [decided, await pending];
}

type AgentLearningActor = {
  kind: "agent";
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

/** The attempt a well-formed agent-attempt grant claims to be; null otherwise. */
function claimedLearningActor(grant: AccessGrant, sessionId: string): AgentLearningActor | null {
  const turnId = grant.metadata?.turnId;
  const attemptId = grant.metadata?.attemptId;
  const executionGeneration = grant.metadata?.executionGeneration;
  if (
    typeof turnId !== "string" ||
    typeof attemptId !== "string" ||
    typeof executionGeneration !== "number"
  ) {
    return null;
  }
  return { kind: "agent", sessionId, turnId, attemptId, executionGeneration };
}

function sameLearningActor(left: AgentLearningActor, right: AgentLearningActor): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.attemptId === right.attemptId &&
    left.executionGeneration === right.executionGeneration
  );
}

type FrozenLearningPolicy = Awaited<ReturnType<typeof freezeAgentLearningPolicy>>;

/**
 * An agent's learning policy is frozen once per accepted turn (a durable
 * snapshot that never changes afterwards), and this request path only uses it
 * after the live-attempt check above has refused stale and interrupted
 * attempts. Re-reading it on every agent request took row locks on the
 * session, turn and attempt for an answer that cannot change, so remember the
 * verified answer per exact attempt. Liveness is still checked on every
 * request; only the immutable policy read is reused.
 */
const FROZEN_LEARNING_LIMIT = 4_096;
const FROZEN_LEARNING_TTL_MS = 15 * 60_000;
const frozenLearningByDatabase = new WeakMap<
  object,
  Map<string, { expiresAt: number; policy: FrozenLearningPolicy }>
>();

function frozenLearningKey(grant: AccessGrant, actor: AgentLearningActor): string {
  return [
    grant.accountId,
    grant.workspaceId,
    actor.sessionId,
    actor.turnId,
    actor.attemptId,
    actor.executionGeneration,
  ].join(":");
}

function frozenLearningCache(database: object) {
  let cache = frozenLearningByDatabase.get(database);
  if (!cache) {
    cache = new Map();
    frozenLearningByDatabase.set(database, cache);
  }
  return cache;
}

function rememberedLearning(
  database: object,
  key: string,
  now = Date.now(),
): FrozenLearningPolicy | null {
  const cache = frozenLearningCache(database);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.policy;
}

function rememberLearning(database: object, key: string, policy: FrozenLearningPolicy): void {
  const cache = frozenLearningCache(database);
  cache.delete(key);
  if (cache.size >= FROZEN_LEARNING_LIMIT) {
    // Map iteration is insertion order: evict the oldest remembered attempt.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + FROZEN_LEARNING_TTL_MS, policy });
}

export async function withAccessGrantSessionRlsContext<T>(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  fn: () => Promise<T>,
): Promise<T> {
  if (grant.principalKind !== "agent_attempt") {
    return await withCreditDebitAttribution(creditDebitAttributionForGrant(grant), () =>
      withSessionRlsActorContext({ subjectId: grant.subjectId }, fn),
    );
  }
  const callerSessionId = grant.metadata?.sessionId;
  if (typeof callerSessionId !== "string") {
    throw agentAttemptAuthorityError("malformed");
  }
  const freezeLearning = (actor: AgentLearningActor) =>
    freezeAgentLearningPolicy(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor,
    });
  try {
    // The learning policy is keyed by the exact attempt, which a live actor
    // takes verbatim from the grant's claims. Read it for the claimed attempt
    // while the liveness check runs; it is used only once that check passes
    // and names the same attempt, and is otherwise read again for the actor.
    // A policy already verified for the claimed attempt needs no read at all.
    const claimed = claimedLearningActor(grant, callerSessionId);
    const claimedKey = claimed ? frozenLearningKey(grant, claimed) : null;
    const remembered = claimedKey ? rememberedLearning(deps.db, claimedKey) : null;
    const [actor, speculative] = await alongsideAuthorization(
      requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId),
      async () => remembered ?? (claimed ? await freezeLearning(claimed) : null),
    );
    const verified: AgentLearningActor = {
      kind: "agent",
      sessionId: actor.callerSessionId,
      turnId: actor.turnId,
      attemptId: actor.attemptId,
      executionGeneration: actor.executionGeneration,
    };
    const verifiedKey = frozenLearningKey(grant, verified);
    const learning =
      claimed && speculative && sameLearningActor(claimed, verified)
        ? speculative
        : (rememberedLearning(deps.db, verifiedKey) ?? (await freezeLearning(verified)));
    rememberLearning(deps.db, verifiedKey, learning);
    return await withCreditDebitAttribution(
      {
        kind: "turn",
        turnId: actor.turnId,
        initiatingHumanSubjectId: actor.initiatingHumanSubjectId ?? null,
      },
      () =>
        withSessionRlsActorContext(
          {
            subjectId: actor.subjectId,
            initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
            agentRootSessionId: actor.callerRootSessionId,
            privateFileOwnerSubjectId:
              learning.defaultScope === "personal" ? learning.subjectId : null,
          },
          fn,
        ),
    );
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw agentAttemptAuthorityError(error.reason, error);
    }
    throw error;
  }
}

/**
 * Prove that an agent-attempt grant is the exact live attempt of its bound
 * session, with the same refusal as {@link withAccessGrantSessionRlsContext},
 * without installing that request's RLS actor context. For requests that read
 * and disclose nothing scoped (MCP protocol handshakes), so they need the
 * liveness fence but none of the actor's data scope.
 */
export async function requireLiveAgentAttemptGrant(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<void> {
  const callerSessionId = grant.metadata?.sessionId;
  if (grant.principalKind !== "agent_attempt" || typeof callerSessionId !== "string") {
    throw agentAttemptAuthorityError("malformed");
  }
  try {
    await requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId);
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw agentAttemptAuthorityError(error.reason, error);
    }
    throw error;
  }
}
