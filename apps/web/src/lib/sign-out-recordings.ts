import { recordingOwnerKey } from "@opengeni/react/meetings-recorder";
import type { ManagedAuthSessionSetProjection } from "@opengeni/sdk/accounts";

/**
 * Whose recordings on this device a browser-account sign-out removes: the
 * account's, or everyone's (null) when nobody stays signed in afterwards.
 */
export function recordingOwnerForSignOut(
  projection: ManagedAuthSessionSetProjection | null | undefined,
  slotId: string | "all",
): string | null {
  if (slotId === "all" || !projection) return null;
  const remaining = projection.slots.filter((slot) => slot.id !== slotId);
  if (remaining.length === 0) return null;
  const slot = projection.slots.find((candidate) => candidate.id === slotId);
  return recordingOwnerKey(slot?.verifiedClaim.value);
}
