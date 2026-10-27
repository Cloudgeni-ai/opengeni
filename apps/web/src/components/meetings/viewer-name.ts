import type { AppContextValue } from "@opengeni/react/app/app-context";

/**
 * What meetings call the signed-in person when they name a speaker as
 * themselves or record: their profile name. A signed-in person's membership
 * label is their email address first, so it is only the fallback.
 */
export function meetingViewerName(
  context: Pick<AppContextValue, "authSession" | "accessContext">,
): string | null {
  return (
    context.authSession?.user.name?.trim() || context.accessContext.subjectLabel?.trim() || null
  );
}
