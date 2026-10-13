import { and, eq, sql } from "drizzle-orm";
import {
  SESSION_USAGE_LIMIT_BASIS,
  SESSION_USAGE_LIMIT_MAX_MICROS,
  type SessionUsageLimit,
  type SessionUsageLimitReachedRefusal,
} from "@opengeni/contracts";
import { sessionUsageLimitReachedMessage } from "@opengeni/contracts/session-usage-limit-refusal";
import { currentCreditDebitAttribution } from "./credit-debit-attribution";
import {
  isTransactionHandle,
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  type Database,
  type SessionActivityDatabase,
} from "./database";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";
import { lockSessionEventWriteRows } from "./session-control";

/**
 * Per-task (root session) API-equivalent usage limits.
 *
 * All state lives in owner-only FORCE-RLS private tables reached through one
 * SECURITY DEFINER command routine. Settlement is synchronous and exactly-once
 * per canonical producer identity; admission reads one indexed counter row and
 * probes the partial index of open single-call custody markers.
 * Limits are admission policy, never reservations: already admitted requests
 * may finish above the limit.
 */

type Scope = { accountId: string; workspaceId: string };

/** The state could not be read or written. Callers must block new model requests, never assume unlimited. */
export class SessionUsageLimitUnavailableError extends Error {
  readonly code = "session_usage_limit_unavailable";
  constructor(message = "Session usage limit state is unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionUsageLimitUnavailableError";
  }
}

/** Agents (including delegated-human or admin-access agents) can never change a limit. */
export class SessionUsageLimitForbiddenError extends Error {
  readonly code = "session_usage_limit_forbidden";
  constructor(message = "Only a person or the trusted host can change a task usage limit") {
    super(message);
    this.name = "SessionUsageLimitForbiddenError";
  }
}

export type SessionUsageLimitReadResult =
  | { outcome: "ok"; state: SessionUsageLimit }
  | { outcome: "not_found" };

export type SessionUsageLimitSetOutcome =
  | "ok"
  | "replayed"
  | "conflict"
  | "operation_conflict"
  | "not_root"
  | "preparing"
  | "disabled"
  | "not_found";

export type SessionUsageLimitSetResult = {
  outcome: SessionUsageLimitSetOutcome;
  state: SessionUsageLimit | null;
  rootSessionId: string | null;
  /** Set when `outcome === "ok"`: the appended `session.usage_limit.updated` event id. */
  eventId?: string;
};

export type SessionUsageReceiptOutcome =
  | "recorded"
  | "duplicate"
  | "filled"
  | "conflict"
  | "source_gone";

type RawState = Record<string, unknown> & { conflicts?: unknown };

const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Retry serialization failures and deadlocks. Inside a caller's transaction
 * a failed statement aborts the whole transaction, so retrying there would
 * only repeat "current transaction is aborted"; the error is surfaced for the
 * caller's own transaction retry instead.
 */
async function withRetry<T>(db: Database, fn: () => Promise<T>, attempts = 4): Promise<T> {
  if (isTransactionHandle(db)) return await fn();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_SQLSTATES.has(sqlState(error) ?? "") || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt + Math.random() * 10));
    }
  }
  throw lastError;
}

/** Strip internal diagnostics and normalize bigint-as-number JSON to the public projection. */
export function projectSessionUsageLimitState(raw: unknown): SessionUsageLimit {
  if (!raw || typeof raw !== "object") throw new Error("Session usage limit state is malformed");
  const value = raw as RawState;
  const num = (field: string): number => {
    const n = value[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
      throw new Error(`Session usage limit state field ${field} is malformed`);
    }
    return n;
  };
  const nullableNum = (field: string): number | null => (value[field] === null ? null : num(field));
  return {
    basis: SESSION_USAGE_LIMIT_BASIS,
    rootSessionId: String(value.rootSessionId),
    inherited: value.inherited === true,
    status: value.status as SessionUsageLimit["status"],
    limitMicros: nullableNum("limitMicros"),
    usedMicros: nullableNum("usedMicros"),
    version: num("version"),
    usageRevision: num("usageRevision"),
    history: value.history as SessionUsageLimit["history"],
    coverage: value.coverage as SessionUsageLimit["coverage"],
    pricedCalls: num("pricedCalls"),
    freeCalls: num("freeCalls"),
    unpricedCalls: num("unpricedCalls"),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

/** Diagnostic-only count of rejected conflicting receipts (never in the public projection). */
export function sessionUsageLimitConflictCount(raw: unknown): number {
  const value = (raw as RawState | null)?.conflicts;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

async function runCommand(
  db: Database,
  input: Scope & Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [row] = await rawRows<{ result: Record<string, unknown> }>(
    db,
    sql`select session_usage_limit_command(${JSON.stringify(input)}::jsonb) as result`,
  );
  if (!row?.result) throw new Error("Session usage limit command returned no result");
  return row.result;
}

/**
 * Read a session's task usage state (through a descendant, the root's state
 * with `inherited: true`). `subjectId` applies private-session visibility; a
 * hidden session is reported as `not_found`. `prepare` advances one bounded
 * page of a pending historical import inline.
 *
 * `runtime` is for server-internal admission on behalf of an already
 * authorized task attempt: the session is resolved tenant-bounded with private
 * visibility cleared, so a private root is enforced rather than read as
 * missing. `openSourceId` (runtime only) opens a pending custody marker for a
 * single call in the same statement, only when the call is admitted.
 */
export async function readSessionUsageLimit(
  db: Database,
  input: Scope & {
    sessionId: string;
    subjectId?: string | null;
    prepare?: boolean;
    runtime?: boolean;
    openSourceId?: string;
  },
): Promise<SessionUsageLimitReadResult & { fenced?: boolean; opened?: boolean }> {
  if (input.openSourceId !== undefined && input.runtime !== true) {
    throw new Error("Only runtime admission can open a usage custody marker");
  }
  try {
    return await withRetry(db, () =>
      withRlsContext(
        db,
        input,
        async (scoped) => {
          if (input.subjectId) await setSubjectRlsContext(scoped, input.subjectId);
          const result = await runCommand(scoped, {
            action: "read",
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            prepare: input.prepare === true,
            ...(input.runtime === true ? { runtime: true } : {}),
            ...(input.openSourceId !== undefined ? { openSourceId: input.openSourceId } : {}),
          });
          if (result.outcome !== "ok") return { outcome: "not_found" as const };
          return {
            outcome: "ok" as const,
            state: projectSessionUsageLimitState(result.state),
            fenced: result.fenced === true,
            opened: result.opened === true,
          };
        },
        undefined,
        "none",
      ),
    );
  } catch (error) {
    throw new SessionUsageLimitUnavailableError(undefined, { cause: error });
  }
}

export type SessionUsageLimitAdmission =
  | { allowed: true; state: SessionUsageLimit | null }
  | { allowed: false; refusal: SessionUsageLimitReachedRefusal; state: SessionUsageLimit };

/** Build the typed refusal for a reached state. */
export function sessionUsageLimitRefusal(
  state: SessionUsageLimit,
): SessionUsageLimitReachedRefusal | null {
  if (state.status !== "reached" || state.limitMicros === null || state.usedMicros === null) {
    return null;
  }
  return {
    code: "session_usage_limit_reached",
    basis: SESSION_USAGE_LIMIT_BASIS,
    rootSessionId: state.rootSessionId,
    limitMicros: state.limitMicros,
    usedMicros: state.usedMicros,
    message: sessionUsageLimitReachedMessage({
      limitMicros: state.limitMicros,
      usedMicros: state.usedMicros,
    }),
  };
}

/**
 * Admission check for one new model request, message or goal resume. Reads
 * the latest durable root counter (one indexed row, no event scan).
 *
 * People-facing checks admit a missing or hidden session as unlimited only
 * because no session exists to account against. Runtime checks fail closed:
 * the attempt already owns the session, so a missing tree, a read failure or a
 * fenced custody marker (an earlier single call whose usage could not be
 * recorded) throws `SessionUsageLimitUnavailableError`.
 */
export async function checkSessionUsageLimitAdmission(
  db: Database,
  input: Scope & {
    sessionId: string;
    subjectId?: string | null;
    runtime?: boolean;
    openSourceId?: string;
  },
): Promise<SessionUsageLimitAdmission> {
  const read = await readSessionUsageLimit(db, input);
  if (read.outcome !== "ok") {
    if (input.runtime === true) {
      throw new SessionUsageLimitUnavailableError("The task for this model request was not found");
    }
    return { allowed: true, state: null };
  }
  if (read.fenced === true) {
    throw new SessionUsageLimitUnavailableError(
      "Usage from an earlier model request in this task is not recorded yet",
    );
  }
  const refusal = sessionUsageLimitRefusal(read.state);
  return refusal
    ? { allowed: false, refusal, state: read.state }
    : { allowed: true, state: read.state };
}

/**
 * Mark an open custody marker as fenced after its owner failed to fill it, so
 * the task blocks new model requests at once instead of after the overdue
 * window. Best effort: callers keep the unrecorded receipt for retry.
 */
export async function fenceSessionUsageReceipt(
  db: Database,
  input: Scope & { sessionId: string; sourceId: string },
): Promise<"fenced" | "not_pending" | "source_gone"> {
  return (await markerCommand(db, "fence", input)) as "fenced" | "not_pending" | "source_gone";
}

/**
 * Remove an unfenced custody marker whose single call returned no response
 * (the provider request failed before any usage was reported).
 */
export async function releaseSessionUsageReceipt(
  db: Database,
  input: Scope & { sessionId: string; sourceId: string },
): Promise<"released" | "not_pending" | "source_gone"> {
  return (await markerCommand(db, "release", input)) as "released" | "not_pending" | "source_gone";
}

async function markerCommand(
  db: Database,
  action: "fence" | "release",
  input: Scope & { sessionId: string; sourceId: string },
): Promise<string> {
  return await withRetry(db, () =>
    withRlsContext(
      db,
      input,
      async (scoped) => {
        const result = await runCommand(scoped, {
          action,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sourceId: input.sourceId,
        });
        return String(result.outcome);
      },
      undefined,
      "none",
    ),
  );
}

/**
 * Record one settled model response against its task root, synchronously and
 * exactly once per `sourceId` (the canonical producer identity). `amountMicros`
 * is the pre-margin `estimatedProviderCostMicros`; null with no pricing source
 * records an unpriced call (excluded from the total and disclosed). Failures
 * throw: the caller must not dispatch another model request until a later
 * settlement or admission read succeeds.
 */
export async function settleSessionUsageReceipt(
  db: Database,
  input: Scope & {
    sessionId: string;
    sourceId: string;
    turnId?: string | null;
    amountMicros: number | null;
    pricingSource: "configured_list_price" | "gateway_reported" | null;
    model?: string | null;
  },
): Promise<{ outcome: SessionUsageReceiptOutcome; state: SessionUsageLimit | null }> {
  if (
    input.amountMicros !== null &&
    (!Number.isSafeInteger(input.amountMicros) || input.amountMicros < 0)
  ) {
    throw new Error("Session usage receipt amount must be a non-negative safe integer");
  }
  try {
    return await settleOnce(db, input);
  } catch (error) {
    // The session's tree was deleted while this settlement waited on its
    // counter row: the receipt's root no longer exists. Same as source_gone.
    if (sqlState(error) === "23503") return { outcome: "source_gone", state: null };
    throw error;
  }
}

async function settleOnce(
  db: Database,
  input: Parameters<typeof settleSessionUsageReceipt>[1],
): Promise<{ outcome: SessionUsageReceiptOutcome; state: SessionUsageLimit | null }> {
  return await withRetry(db, () =>
    withRlsContext(
      db,
      input,
      async (scoped) => {
        const result = await runCommand(scoped, {
          action: "settle",
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sourceId: input.sourceId,
          turnId: input.turnId ?? null,
          amountMicros: input.amountMicros,
          pricingSource: input.amountMicros === null ? null : input.pricingSource,
          model: input.model ?? null,
        });
        const outcome = result.outcome as SessionUsageReceiptOutcome;
        return {
          outcome,
          state: result.state ? projectSessionUsageLimitState(result.state) : null,
        };
      },
      undefined,
      "none",
    ),
  );
}

export type SessionUsageLimitWriteActor = {
  /** Verified human subject or trusted host identity; never an agent attempt. */
  subjectId: string;
  type: "human" | "host";
};

/**
 * Compare-and-set a root task's limit inside the caller's session-activity
 * transaction, appending `session.usage_limit.updated` on change. Takes the
 * canonical workspace/session event-write prefix before the private counter
 * row. Never wakes, resumes or interrupts a turn.
 */
type SessionUsageLimitSetInput = Scope & {
  sessionId: string;
  limitMicros: number | null;
  expectedVersion: number;
  operationId: string;
  actor: SessionUsageLimitWriteActor;
  /** Producer flag; when false only clearing (null) is accepted. */
  producerEnabled: boolean;
};

async function runSetCommand(
  db: Database,
  input: SessionUsageLimitSetInput,
): Promise<{
  outcome: SessionUsageLimitSetOutcome;
  state: SessionUsageLimit | null;
  rootSessionId: string | null;
  previousLimitMicros: unknown;
}> {
  if (currentCreditDebitAttribution().kind === "turn") {
    // Installed by the authenticated agent-attempt boundary, never request JSON.
    throw new SessionUsageLimitForbiddenError();
  }
  if (
    input.limitMicros !== null &&
    (!Number.isSafeInteger(input.limitMicros) ||
      input.limitMicros < 0 ||
      input.limitMicros > SESSION_USAGE_LIMIT_MAX_MICROS)
  ) {
    throw new RangeError("Session usage limit must be null or 0..$10,000,000 in micros");
  }
  const result = await runCommand(db, {
    action: "set",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    limitMicros: input.limitMicros,
    expectedVersion: input.expectedVersion,
    operationId: input.operationId,
    actorSubjectId: input.actor.subjectId,
    actorType: input.actor.type,
    producerEnabled: input.producerEnabled,
  });
  return {
    outcome: result.outcome as SessionUsageLimitSetOutcome,
    state: result.state ? projectSessionUsageLimitState(result.state) : null,
    rootSessionId: typeof result.rootSessionId === "string" ? result.rootSessionId : null,
    previousLimitMicros: result.previousLimitMicros,
  };
}

/**
 * The limit a person or trusted host requested on create, applied inside the
 * session-creating transaction (which already owns the new row) before the
 * initial turn can be claimed. No event: the create response carries the
 * state. Version 0 and a create-scoped operation make it exactly once.
 */
export async function setInitialSessionUsageLimitInTransaction(
  db: Database,
  input: Omit<SessionUsageLimitSetInput, "expectedVersion" | "operationId">,
): Promise<SessionUsageLimitSetResult> {
  const { outcome, state, rootSessionId } = await runSetCommand(db, {
    ...input,
    expectedVersion: 0,
    operationId: `create:${input.sessionId}`,
  });
  return { outcome, state, rootSessionId };
}

/**
 * A later change to a root's limit: CAS on `expectedVersion`, idempotent on
 * `operationId`, and a durable `session.usage_limit.updated` event under the
 * canonical session event-write locks.
 */
export async function setSessionUsageLimitInTransaction(
  db: SessionActivityDatabase,
  input: SessionUsageLimitSetInput,
): Promise<SessionUsageLimitSetResult> {
  const session = (
    await lockSessionEventWriteRows(db, {
      workspaceId: input.workspaceId,
      controlLock: "share",
      sessionIds: [input.sessionId],
    })
  ).sessions.find((row) => row.id === input.sessionId);
  if (!session || session.accountId !== input.accountId) {
    return { outcome: "not_found", state: null, rootSessionId: null };
  }
  const { outcome, state, rootSessionId, previousLimitMicros } = await runSetCommand(db, input);
  if (outcome !== "ok" || !state) {
    return { outcome, state, rootSessionId };
  }
  const sequence = session.lastSequence + 1;
  const now = new Date();
  await db
    .update(schema.sessions)
    .set({ lastSequence: sequence, updatedAt: now })
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    );
  const previous = previousLimitMicros;
  const [event] = await db
    .insert(schema.sessionEvents)
    .values(
      withLosslessContentWriteVersion(
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sequence,
          type: "session.usage_limit.updated",
          payload: {
            basis: SESSION_USAGE_LIMIT_BASIS,
            limitMicros: state.limitMicros,
            previousLimitMicros: typeof previous === "number" ? previous : null,
            version: state.version,
          },
          occurredAt: now,
        },
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new Error("Session usage limit event was not persisted");
  return { outcome, state, rootSessionId, eventId: event.id };
}

export type SessionUsageLimitMaintenanceResult = {
  /** Roots whose import advanced a page. */
  processed: number;
  /** Roots whose import page failed and was backed off. */
  failed: number;
  /** Content-free failure diagnostics: SQLSTATE to count. */
  errors: Record<string, number>;
  /** Custody markers left unfilled past the lost window, now disclosed as unpriced. */
  resolvedLost: number;
};

/**
 * One bounded, resumable maintenance pass: advance the historical import for
 * roots created before this feature (failed pages back off exponentially and
 * keep their SQLSTATE) and resolve lost single-call custody markers. Safe to
 * call from any periodic maintenance loop.
 */
export async function maintainSessionUsageLimits(
  db: Database,
  input: { limit?: number; budget?: number } = {},
): Promise<SessionUsageLimitMaintenanceResult> {
  const [row] = await rawRows<{ result: Record<string, unknown> | null }>(
    db,
    sql`select maintain_session_usage_limits(${input.limit ?? 20}::integer, ${input.budget ?? 500}::integer) as result`,
  );
  const result = row?.result ?? {};
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const errors: Record<string, number> = {};
  if (result.errors && typeof result.errors === "object") {
    for (const [code, value] of Object.entries(result.errors as Record<string, unknown>)) {
      if (/^[0-9A-Z]{5}$/.test(code)) errors[code] = count(value);
    }
  }
  return {
    processed: count(result.processed),
    failed: count(result.failed),
    errors,
    resolvedLost: count(result.resolvedLost),
  };
}
