import type { Database } from "@opengeni/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ManagedAuth } from "./managed-auth-type";
import { getManagedSession } from "./managed-session";

export type CanonicalHumanRequestIdentity = {
  authUserId: string;
  authSessionId: string;
};

export async function requireCanonicalHumanRequestIdentity(
  context: Context,
  input: { db: Database; managedAuth?: ManagedAuth | null; allowRecovery?: boolean },
): Promise<CanonicalHumanRequestIdentity> {
  if (!input.managedAuth) {
    throw new HTTPException(404, { message: "Canonical human identity is unavailable" });
  }
  const session = await getManagedSession(context, input.managedAuth, {
    db: input.db,
    ...(input.allowRecovery === undefined ? {} : { allowIdentityRecovery: input.allowRecovery }),
  });
  if (!session?.user || typeof session.session?.id !== "string") {
    throw new HTTPException(401, { message: "Managed human authentication required" });
  }
  return { authUserId: session.user.id, authSessionId: session.session.id };
}
