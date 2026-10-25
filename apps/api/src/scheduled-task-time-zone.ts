import {
  messageTimeZoneFromTurnMetadata,
  type AccessGrant,
  type ScheduledTaskScheduleSpec,
} from "@opengeni/contracts";
import { getSessionTurn, type Database } from "@opengeni/db";

/** Where the time zone of an agent-written schedule came from when the call omitted it. */
export type ScheduleTimeZoneDefault = {
  timeZone: string;
  source: "message" | "existing_schedule" | "utc";
};

/** Schedule types whose clock times are read in a time zone. */
const ZONED_SCHEDULE_TYPES = new Set(["once", "calendar"]);

function omitsTimeZone(schedule: unknown): schedule is Record<string, unknown> {
  return (
    schedule !== null &&
    typeof schedule === "object" &&
    !Array.isArray(schedule) &&
    ZONED_SCHEDULE_TYPES.has(String((schedule as Record<string, unknown>).type)) &&
    (schedule as Record<string, unknown>).timeZone === undefined
  );
}

/**
 * The time zone frozen with the turn an agent is running, from the message
 * that started it. Only an agent attempt has a calling turn.
 */
async function callingTurnMessageTimeZone(
  db: Database,
  grant: AccessGrant,
): Promise<string | undefined> {
  if (grant.principalKind !== "agent_attempt") return undefined;
  const turnId = grant.metadata?.["turnId"];
  if (typeof turnId !== "string") return undefined;
  const turn = await getSessionTurn(db, grant.workspaceId, turnId);
  return messageTimeZoneFromTurnMetadata(turn?.metadata);
}

/**
 * Fill the time zone an agent left out of a clock-based schedule, before the
 * request is parsed (whose own default is UTC). People asking for "every
 * Monday at 9" mean their own 9, so a new schedule uses the zone of the
 * message that asked for it. An edited schedule keeps its current zone. UTC
 * applies only when there is neither. Calls from people (not agents) and
 * schedules that name a zone are unchanged.
 */
export async function withAgentScheduleTimeZone<T>(
  db: Database,
  grant: AccessGrant,
  input: T,
  existing?: ScheduledTaskScheduleSpec | null,
): Promise<{ input: T; timeZoneDefault: ScheduleTimeZoneDefault | null }> {
  const schedule =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).schedule
      : undefined;
  if (grant.principalKind !== "agent_attempt" || !omitsTimeZone(schedule))
    return { input, timeZoneDefault: null };
  const current = existing && "timeZone" in existing ? existing.timeZone : undefined;
  const fromMessage = current ? undefined : await callingTurnMessageTimeZone(db, grant);
  const timeZoneDefault: ScheduleTimeZoneDefault = current
    ? { timeZone: current, source: "existing_schedule" }
    : fromMessage
      ? { timeZone: fromMessage, source: "message" }
      : { timeZone: "UTC", source: "utc" };
  return {
    input: { ...input, schedule: { ...schedule, timeZone: timeZoneDefault.timeZone } },
    timeZoneDefault,
  };
}

/** Receipt facts that tell the agent which zone a defaulted schedule uses. */
export function scheduleTimeZoneFacts(
  timeZoneDefault: ScheduleTimeZoneDefault | null,
): Record<string, string> | undefined {
  return timeZoneDefault
    ? {
        scheduleTimeZone: timeZoneDefault.timeZone,
        scheduleTimeZoneSource: timeZoneDefault.source,
      }
    : undefined;
}
