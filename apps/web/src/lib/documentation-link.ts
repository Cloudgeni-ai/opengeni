import type { ClientConfig } from "@/types";

/**
 * The documentation URL the console's Help menu opens, or null when there is
 * none to show. The server owns the default and the operator's choice: `null`
 * means the deployment hides the link, and a server that predates the field
 * advertises nothing, so the console never guesses an operator's docs. Only
 * absolute http(s) URLs reach an `href`.
 */
export function documentationLinkFromClientConfig(
  config: Pick<ClientConfig, "documentationUrl">,
): string | null {
  const value = config.documentationUrl;
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}
