export type InteractionHostPlatform = "mac" | "other";

/** Physical client platform. Remote input adapters use this only to identify
 * the user's primary shortcut modifier; the target platform is resolved
 * separately. */
export function interactionHostPlatform(): InteractionHostPlatform {
  if (typeof navigator === "undefined") return "other";
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/u.test(platform) ? "mac" : "other";
}
