import type { Database } from "@opengeni/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ManagedAuth } from "./managed-auth-type";
import { getManagedSession } from "./managed-session";
export {
  getManagedAuthRequestActorAdmissionStamp,
  getManagedAuthRequestActorLeaseStamp,
  markManagedAuthRequestActorTransitionApplied,
} from "./managed-session";
import type { ManagedAuthSessionAdapter } from "./managed-auth-session-sets";
import type { ManagedAuthSessionSetMode } from "@opengeni/contracts/managed-auth-session-sets";

export type CanonicalHumanRequestIdentity = {
  authUserId: string;
  authSessionId: string;
};

export async function requireCanonicalHumanRequestIdentity(
  context: Context,
  input: {
    db: Database;
    managedAuth?: ManagedAuth | null | undefined;
    managedAuthSessionAdapter?: ManagedAuthSessionAdapter | null | undefined;
    managedAuthSessionSetMode?: ManagedAuthSessionSetMode | undefined;
    allowRecovery?: boolean | undefined;
  },
): Promise<CanonicalHumanRequestIdentity> {
  if (!input.managedAuth) {
    throw new HTTPException(404, {
      message: "Canonical human identity is unavailable",
    });
  }
  const session = await getManagedSession(context, input.managedAuth, {
    db: input.db,
    sessionAdapter: input.managedAuthSessionAdapter,
    sessionSetMode: input.managedAuthSessionSetMode,
    ...(input.allowRecovery === undefined ? {} : { allowIdentityRecovery: input.allowRecovery }),
  });
  if (!session?.user || typeof session.session?.id !== "string") {
    throw new HTTPException(401, {
      message: "Managed human authentication required",
    });
  }
  return { authUserId: session.user.id, authSessionId: session.session.id };
}
