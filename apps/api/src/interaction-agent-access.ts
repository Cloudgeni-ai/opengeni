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
 */
export async function filterInteractionSessionsForGrant<T extends AssociatedInteractionSession>(
  deps: Pick<ApiRouteDeps, "db" | "sessionAuthorization">,
  grant: AccessGrant,
  sessions: readonly T[],
): Promise<T[]> {
  const decisions = new Map<string, Promise<boolean>>();
  const authorized = (sessionId: string): Promise<boolean> => {
    let decision = decisions.get(sessionId);
    if (!decision) {
      decision = requireSessionAuthorization(deps, grant, {
        sessionId,
        operation: "session.read",
        surface: "http",
      })
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof SessionAuthorizationDeniedError) return false;
          throw error;
        });
      decisions.set(sessionId, decision);
    }
    return decision;
  };
  const kept: T[] = [];
  for (const session of sessions) {
    const sources = session.associations.filter((entry) => entry.relationship === "created");
    // Control-record resolution also requires exactly one creation association.
    // Incomplete or ambiguous records cannot establish a discoverable owner.
    if (sources.length === 1 && (await authorized(sources[0]!.sessionId))) kept.push(session);
  }
  return kept;
}
