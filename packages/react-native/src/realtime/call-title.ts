import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  deriveSessionDisplayTitle,
  type SessionDisplayTitleInput,
} from "@opengeni/sdk";

/**
 * The name a call shows for its session: the session's own title or opening
 * prompt preview, else the host's untitled label. A brand-new session (a call
 * started from an empty composer) has neither, and an ID-derived reference
 * such as "Conversation 1a2b3c4d-5e6f" is not a name worth showing on a call.
 */
export function nativeCallTitle(
  session: SessionDisplayTitleInput | null | undefined,
  untitled: string,
): string {
  if (!session) return untitled;
  const named = deriveSessionDisplayTitle({ ...session, id: null });
  return named === AUTOMATIC_SESSION_TITLE_FALLBACK ? untitled : named;
}
