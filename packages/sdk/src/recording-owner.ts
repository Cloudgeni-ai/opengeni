import type { RecordingCaptureSource } from "@opengeni/contracts";

/** The longest owner name a new recording takes, in UTF-16 code units. */
const OWNER_NAME_MAX = 200;

/**
 * The owner's name for a new recording, sent only when its microphone is
 * theirs (computer or tab audio beside it), cut to what the server takes
 * without splitting a character.
 */
export function ownerNameField(
  name: string | null | undefined,
  tracks: readonly { source: RecordingCaptureSource }[],
): { ownerName?: string } {
  const trimmed = name?.trim();
  if (
    !trimmed ||
    !tracks.some((track) => track.source === "microphone") ||
    !tracks.some((track) => track.source === "system")
  ) {
    return {};
  }
  let ownerName = "";
  for (const character of trimmed) {
    if (ownerName.length + character.length > OWNER_NAME_MAX) break;
    ownerName += character;
  }
  return { ownerName: ownerName.trim() };
}
