/**
 * Codex's provider id on the provider-neutral subscription-core routines
 * (migration 0706). The neutral routines take the provider as data; Codex
 * passes this id.
 */
export const SUBSCRIPTION_CORE_CODEX_PROVIDER = "codex";

/**
 * The stored relogin text. The neutral routines default an empty text to a
 * provider-free one, so Codex passes its own default (the text the
 * provider-named routines store) to keep stored values unchanged.
 */
export function subscriptionCoreCodexReloginText(message: string): string {
  return message.trim().length > 0 ? message : "Codex sign-in expired";
}
