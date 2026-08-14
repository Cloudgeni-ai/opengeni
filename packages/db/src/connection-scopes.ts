/**
 * Canonical comparison key for provider-reported OAuth scopes.
 *
 * Google may return the canonical userinfo scope URLs after the application
 * requested the standard `email` / `profile` aliases. Microsoft scope names
 * are case-insensitive. All other providers retain exact comparison.
 */
export function connectionScopeKey(providerDomain: string, value: string): string {
  const scope = value.trim();
  const domain = providerDomain.toLowerCase();
  if (domain === "googleapis.com" || domain.endsWith(".googleapis.com")) {
    if (scope === "email" || scope === "https://www.googleapis.com/auth/userinfo.email") {
      return "google:email";
    }
    if (scope === "profile" || scope === "https://www.googleapis.com/auth/userinfo.profile") {
      return "google:profile";
    }
  }
  return domain === "graph.microsoft.com" ? scope.toLowerCase() : scope;
}
