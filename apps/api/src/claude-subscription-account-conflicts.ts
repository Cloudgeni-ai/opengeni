import { nestedPostgresSqlState, SubscriptionAccountChangedError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export function claudeAccountMutationFailure(error: unknown): never {
  if (error instanceof SubscriptionAccountChangedError)
    throw new HTTPException(409, { message: error.message });
  if (nestedPostgresSqlState(error) === "23505")
    throw new HTTPException(409, {
      message: "This Claude subscription is already connected to this pool.",
    });
  throw error;
}
