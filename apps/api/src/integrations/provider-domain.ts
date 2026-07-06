import { HTTPException } from "hono/http-exception";

/**
 * Canonical form of a connection's providerDomain: trimmed, lowercased, no
 * leading "www.". Rejects a value that canonicalizes to empty (whitespace-only,
 * or a bare "www.") — `min(1)` validation passes such input, but an empty stored
 * domain silently breaks the enable-time connectionRef domain match.
 */
export function canonicalProviderDomain(value: string): string {
  const canonical = value.trim().toLowerCase().replace(/^www\./, "");
  if (!canonical) {
    throw new HTTPException(400, { message: "providerDomain must not be empty" });
  }
  return canonical;
}
