/** Canonical form of a connection's providerDomain: trimmed, lowercased, no leading "www.". */
export function canonicalProviderDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "");
}
