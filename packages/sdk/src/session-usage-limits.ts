// @opengeni/sdk/session-usage-limits — per-task usage limit helpers that are
// safe in browsers and React Native. Reads and writes use the root client's
// `getSessionUsageLimit` / `setSessionUsageLimit`, or these free functions over
// any client's `requestJson`.
//
// Amounts are integer USD micros of API-equivalent model usage (the
// pre-margin provider list-price estimate), not your bill. The limit is
// checked before each new model request: requests already running can take
// recorded usage above it. See docs/session-usage-limits.md.
import type { OpenGeniClient, OpenGeniRequestOptions } from "./client";
import type {
  SessionUsageLimit,
  SetSessionUsageLimitRequest,
} from "@opengeni/contracts/session-usage-limits";

export type {
  SessionUsageLimit,
  SessionUsageLimitHistory,
  SessionUsageLimitReachedRefusal,
  SessionUsageLimitStatus,
  SetSessionUsageLimitRequest,
} from "@opengeni/contracts/session-usage-limits";
export {
  formatSessionUsageMicros,
  parseSessionUsageLimitReachedRefusal,
  SESSION_USAGE_LIMIT_GOAL_PAUSED_REASON,
  SESSION_USAGE_LIMIT_SEGMENT,
  sessionUsageLimitReachedMessage,
} from "@opengeni/contracts/session-usage-limit-refusal";
export type { ParsedSessionUsageLimitReachedRefusal } from "@opengeni/contracts/session-usage-limit-refusal";

type RequestJsonClient = Pick<OpenGeniClient, "requestJson">;

function usageLimitPath(workspaceId: string, sessionId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/usage-limit`;
}

/** Read a task's usage limit state (a child returns its root's, `inherited: true`). */
export async function getSessionUsageLimit(
  client: RequestJsonClient,
  workspaceId: string,
  sessionId: string,
  options: OpenGeniRequestOptions = {},
): Promise<SessionUsageLimit> {
  return await client.requestJson<SessionUsageLimit>(
    "GET",
    usageLimitPath(workspaceId, sessionId),
    undefined,
    {},
    options,
  );
}

/** Compare-and-set a root task's limit; `limitMicros: null` clears it. Never resumes work. */
export async function setSessionUsageLimit(
  client: RequestJsonClient,
  workspaceId: string,
  sessionId: string,
  request: SetSessionUsageLimitRequest,
): Promise<SessionUsageLimit> {
  const committed = await client.requestJson<SessionUsageLimit>(
    "PUT",
    usageLimitPath(workspaceId, sessionId),
    request,
  );
  if (committed.limitMicros !== request.limitMicros) {
    throw new Error(
      "The server did not confirm the requested usage limit; it may not support usage limits.",
    );
  }
  return committed;
}
