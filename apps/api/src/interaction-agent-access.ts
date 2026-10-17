import type { AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  type ApiRouteDeps,
} from "@opengeni/core";

type AssociatedInteractionSession = {
  associations: ReadonlyArray<{ sessionId: string; relationship: string }>;
};

const InteractionSessionListQuery = z
  .object({
    associatedSessionId: z.string().uuid().optional(),
    includeTerminal: z.enum(["true", "false"]).optional(),
  })
  .strict();

/**
 * Optional narrowing filters for BrowserSession/ComputerSession inventories,
 * applied in SQL before per-source authorization. They narrow, never grant:
 * every returned row still passes filterInteractionSessionsForGrant.
 */
export function parseInteractionSessionListQuery(query: Record<string, string>): {
  associatedSessionId?: string;
  includeTerminal?: boolean;
} {
  const parsed = InteractionSessionListQuery.safeParse(query);
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Invalid interaction session list query" });
  }
  return {
    ...(parsed.data.associatedSessionId
      ? { associatedSessionId: parsed.data.associatedSessionId.toLowerCase() }
      : {}),
    ...(parsed.data.includeTerminal
      ? { includeTerminal: parsed.data.includeTerminal === "true" }
      : {}),
  };
}

/**
 * Apply the same source-chat authorization as get/control routes, for every
 * caller. A later using/observing/related association never transfers ownership
 * or makes a private interaction discoverable through another chat.
 *
 * Each distinct source chat is checked once. The checks are independent reads,
 * so they run a bounded number at a time rather than one after another: a
 * workspace inventory spanning a hundred chats otherwise costs a hundred
 * sequential round trips.
 */
export async function filterInteractionSessionsForGrant<T extends AssociatedInteractionSession>(
  deps: Pick<ApiRouteDeps, "db" | "sessionAuthorization">,
  grant: AccessGrant,
  sessions: readonly T[],
): Promise<T[]> {
  // Control-record resolution also requires exactly one creation association.
  // Incomplete or ambiguous records cannot establish a discoverable owner.
  const sourceOf = (session: T): string | null => {
    const sources = session.associations.filter((entry) => entry.relationship === "created");
    return sources.length === 1 ? sources[0]!.sessionId : null;
  };
  const sourceIds = [...new Set(sessions.map(sourceOf).filter((id): id is string => id !== null))];
  const allowed = new Set<string>();
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < sourceIds.length) {
      const sessionId = sourceIds[next++]!;
      try {
        await requireSessionAuthorization(deps, grant, {
          sessionId,
          operation: "session.read",
          surface: "http",
        });
        allowed.add(sessionId);
      } catch (error) {
        if (error instanceof SessionAuthorizationDeniedError) continue;
        // An authorization outage fails the whole inventory, never a partial one.
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(INTERACTION_SOURCE_AUTHORIZATION_CONCURRENCY, sourceIds.length) },
      worker,
    ),
  );
  if (failure) throw (failure as { error: unknown }).error;
  return sessions.filter((session) => {
    const source = sourceOf(session);
    return source !== null && allowed.has(source);
  });
}

/** Source-chat checks in flight at once for one inventory request. */
export const INTERACTION_SOURCE_AUTHORIZATION_CONCURRENCY = 8;
