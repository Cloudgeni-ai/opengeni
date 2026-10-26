import { and, eq, sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import { agentCalls } from "./schema";

// Agents calling people (0988, docs/design/agent-calls.md). A call rings the
// callee's opted-in phones until its deadline; the first answer wins, and a
// decline, the deadline or the agent cancelling ends the ring everywhere.

/** How long a call rings before it counts as missed. */
export const AGENT_CALL_RING_SECONDS = 40;
/** At most this many calls from one chat within an hour. */
export const AGENT_CALL_HOURLY_LIMIT = 3;
/** After a decline, the same chat cannot ring that person again for this long. */
export const AGENT_CALL_DECLINE_COOLDOWN_MINUTES = 15;
/**
 * An answer that arrives this soon after the deadline still wins (network
 * latency); a call only counts as missed once this grace has passed too.
 */
export const AGENT_CALL_ANSWER_GRACE_SECONDS = 5;

export type AgentCallState = "ringing" | "answered" | "declined" | "missed" | "cancelled";
export type AgentCallOutcome = Exclude<AgentCallState, "ringing">;

export type AgentCallRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  calleeSubjectId: string;
  callerSubjectId: string | null;
  callerLabel: string | null;
  reason: string;
  state: AgentCallState;
  devices: number;
  ringUntil: string;
  answeredBy: string | null;
  realtimeId: string | null;
  createdAt: string;
  endedAt: string | null;
};

function mapCall(row: typeof agentCalls.$inferSelect): AgentCallRow {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    calleeSubjectId: row.calleeSubjectId,
    callerSubjectId: row.callerSubjectId,
    callerLabel: row.callerLabel,
    reason: row.reason,
    state: row.state as AgentCallState,
    devices: row.devices,
    ringUntil: row.ringUntil.toISOString(),
    answeredBy: row.answeredBy,
    realtimeId: row.realtimeId,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

export type AgentCallScope = { accountId: string; workspaceId: string };

/** Why a call did not ring. Each is an expected outcome the agent is told about. */
export type AgentCallRefusal =
  /** No phone of the callee lets agents call it. */
  | "no_phone"
  /** Another call is ringing them right now. */
  | "busy"
  /** This chat already called AGENT_CALL_HOURLY_LIMIT times in the last hour. */
  | "rate_limited"
  /** They declined a call from this chat a moment ago. */
  | "declined_recently";

export type PlaceAgentCallResult =
  | { placed: true; call: AgentCallRow }
  | { placed: false; refusal: AgentCallRefusal };

/** How many of a person's phones an agent may ring (for their own agents, or a teammate's). */
export async function countAgentCallDevices(
  db: Database,
  input: { calleeSubjectId: string; member: boolean },
): Promise<number> {
  const [row] = await rawRows<{ devices: number }>(
    db,
    sql`select opengeni_private.agent_call_device_count_v1(
      ${input.calleeSubjectId}::text, ${input.member}::boolean
    ) as devices`,
  );
  return Number(row?.devices ?? 0);
}

/**
 * Ring the callee's phones, when their settings and the limits allow. The
 * call row and its rings commit together; the push dispatcher sends them.
 * `member` is true when the agent works for someone else than the callee.
 */
export async function placeAgentCall(
  db: Database,
  input: AgentCallScope & {
    sessionId: string;
    calleeSubjectId: string;
    callerSubjectId: string | null;
    callerLabel: string | null;
    reason: string;
    member: boolean;
    ringSeconds?: number;
  },
): Promise<PlaceAgentCallResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) => {
      // One decision at a time per callee, so two agents cannot both ring them.
      await scoped.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`opengeni:agent-call:${input.calleeSubjectId}`}::text, 0))`,
      );
      if ((await countAgentCallDevices(scoped, input)) === 0) {
        return { placed: false, refusal: "no_phone" };
      }
      const [busy] = await rawRows<{ ringing: boolean }>(
        scoped,
        sql`select opengeni_private.agent_call_ringing_v1(${input.calleeSubjectId}::text) as ringing`,
      );
      if (busy?.ringing) return { placed: false, refusal: "busy" };
      const [recent] = await rawRows<{ calls: number; declined: number }>(
        scoped,
        sql`select
          count(*) filter (where created_at > now() - interval '1 hour')::integer as calls,
          count(*) filter (
            where state = 'declined' and callee_subject_id = ${input.calleeSubjectId}
              and ended_at > now() - make_interval(mins => ${AGENT_CALL_DECLINE_COOLDOWN_MINUTES}::integer)
          )::integer as declined
        from agent_calls
        where workspace_id = ${input.workspaceId}::uuid and session_id = ${input.sessionId}::uuid
          and created_at > now() - interval '1 hour'`,
      );
      if (Number(recent?.declined ?? 0) > 0) {
        return { placed: false, refusal: "declined_recently" };
      }
      if (Number(recent?.calls ?? 0) >= AGENT_CALL_HOURLY_LIMIT) {
        return { placed: false, refusal: "rate_limited" };
      }
      const seconds = input.ringSeconds ?? AGENT_CALL_RING_SECONDS;
      const [row] = await scoped
        .insert(agentCalls)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          calleeSubjectId: input.calleeSubjectId,
          callerSubjectId: input.callerSubjectId,
          callerLabel: input.callerLabel?.slice(0, 200) || null,
          reason: input.reason.slice(0, 200),
          ringUntil: sql`now() + make_interval(secs => ${seconds}::integer)`,
        })
        .returning();
      if (!row) throw new Error("Failed to place the agent call");
      const [rung] = await rawRows<{ devices: number }>(
        scoped,
        sql`select opengeni_private.ring_agent_call_v1(${row.id}::uuid, ${input.member}::boolean) as devices`,
      );
      const devices = Number(rung?.devices ?? 0);
      const [updated] = await scoped
        .update(agentCalls)
        .set({ devices })
        .where(eq(agentCalls.id, row.id))
        .returning();
      return { placed: true, call: mapCall(updated ?? row) };
    },
  );
}

export async function getAgentCall(
  db: Database,
  input: AgentCallScope & { callId: string },
): Promise<AgentCallRow | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) => {
      const [row] = await scoped
        .select()
        .from(agentCalls)
        .where(and(eq(agentCalls.workspaceId, input.workspaceId), eq(agentCalls.id, input.callId)))
        .limit(1);
      return row ? mapCall(row) : null;
    },
  );
}

/**
 * Move a ringing call to its outcome. Only the first transition wins: it
 * returns the settled call, and every later or late attempt returns null.
 * An answer must come from the callee within the ring (plus a short grace);
 * `missed` only applies once the deadline and that grace have passed.
 */
export async function settleAgentCall(
  db: Database,
  input: AgentCallScope & {
    callId: string;
    outcome: AgentCallOutcome;
    /** The person answering or declining; must be the callee. */
    calleeSubjectId?: string;
    /** The app session that answered. */
    answeredBy?: string;
  },
): Promise<AgentCallRow | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) => {
      const conditions = [
        eq(agentCalls.workspaceId, input.workspaceId),
        eq(agentCalls.id, input.callId),
        eq(agentCalls.state, "ringing"),
      ];
      if (input.calleeSubjectId) {
        conditions.push(eq(agentCalls.calleeSubjectId, input.calleeSubjectId));
      }
      if (input.outcome === "answered") {
        conditions.push(
          sql`${agentCalls.ringUntil} + make_interval(secs => ${AGENT_CALL_ANSWER_GRACE_SECONDS}::integer) > now()`,
        );
      } else if (input.outcome === "missed") {
        conditions.push(
          sql`${agentCalls.ringUntil} + make_interval(secs => ${AGENT_CALL_ANSWER_GRACE_SECONDS}::integer) <= now()`,
        );
      }
      const [row] = await scoped
        .update(agentCalls)
        .set({
          state: input.outcome,
          endedAt: sql`now()`,
          ...(input.outcome === "answered" && input.answeredBy
            ? { answeredBy: input.answeredBy.slice(0, 300) }
            : {}),
        })
        .where(and(...conditions))
        .returning();
      return row ? mapCall(row) : null;
    },
  );
}

/**
 * The call this person answered in this session moments ago that no voice
 * call has opened with yet; claims it for `realtimeId`. Runs inside the
 * realtime start transaction (which holds the workspace RLS context).
 */
export async function claimAnsweredAgentCallForRealtimeInTransaction(
  db: Database,
  input: AgentCallScope & {
    sessionId: string;
    calleeSubjectId: string;
    realtimeId: string;
    withinSeconds?: number;
  },
): Promise<AgentCallRow | null> {
  const [row] = await rawRows<{ id: string }>(
    db,
    sql`update agent_calls set realtime_id = ${input.realtimeId}::uuid
      where id = (
        select id from agent_calls
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
          and session_id = ${input.sessionId}::uuid
          and callee_subject_id = ${input.calleeSubjectId}::text
          and state = 'answered' and realtime_id is null
          and ended_at > now() - make_interval(secs => ${input.withinSeconds ?? 120}::integer)
        order by ended_at desc limit 1
        for update
      )
      returning id`,
  );
  if (!row) return null;
  const [call] = await db.select().from(agentCalls).where(eq(agentCalls.id, row.id)).limit(1);
  return call ? mapCall(call) : null;
}
