// Deployment addresses, kept free of native modules so pure logic and tests can use them.

/** A deployment address as typed: trimmed, https by default, no trailing slash. */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  const match = /^(https?):\/\/([a-z0-9.-]+(?::\d{1,5})?)(?:[/?#].*)?$/iu.exec(withScheme);
  return match ? `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}` : null;
}

/** The host a person recognizes, e.g. app.opengeni.ai. */
export function serverLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//iu, "");
}
