/** Persisted discriminator; null identity alone never implies ephemeral storage. */
export const EPHEMERAL_CHROMIUM_DRIVER_ID = "opengeni.cdp.ephemeral-context.v1" as const;

export function browserSessionStorageMode(session: {
  driverId: string;
}): "private_profile" | "ephemeral_context" {
  return session.driverId === EPHEMERAL_CHROMIUM_DRIVER_ID
    ? "ephemeral_context"
    : "private_profile";
}
