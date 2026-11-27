import type { AppContextValue } from "../app-context";

/**
 * Who is reading through the app's client. The SDK client can outlive a
 * cookie/key change, so this includes the key version, the signed-in person
 * and their live grants: a demotion or another person never takes the
 * previous viewer's reads.
 */
export function appViewerKey(
  context: Pick<AppContextValue, "accessContext" | "accessKeyVersion" | "authSession">,
): string {
  const { accessContext, accessKeyVersion, authSession } = context;
  return JSON.stringify([accessKeyVersion, authSession?.user.id, accessContext]);
}
