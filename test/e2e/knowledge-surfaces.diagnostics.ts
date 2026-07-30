const disabledMachinesConsoleError =
  /^Failed to load resource: the server responded with a status of 404\b/;

export type BrowserResponseDiagnostic = {
  status: number;
  method: string;
  url: string;
};

export type BrowserConsoleDiagnostic = {
  text: string;
  locationUrl: string;
};

/**
 * Connected Machines is deliberately invisible when the selfhosted feature is
 * disabled. Keep this allow-list tied to the product flag and exact endpoint;
 * every other response remains an actionable browser diagnostic.
 */
export function isExpectedDisabledMachinesResponse(
  response: BrowserResponseDiagnostic,
  sandboxSelfhostedEnabled: boolean,
): boolean {
  if (sandboxSelfhostedEnabled || response.status !== 404) return false;
  if (response.method.toUpperCase() !== "GET") return false;

  try {
    return /^\/v1\/workspaces\/[^/]+\/machines$/.test(new URL(response.url).pathname);
  } catch {
    return false;
  }
}

/**
 * Chromium may emit a duplicate console diagnostic for the same failed
 * response. Suppress it only when the exact response URL was already accepted
 * by isExpectedDisabledMachinesResponse; an identical message from any other
 * URL is still unexpected.
 */
export function isExpectedDisabledMachinesConsoleError(
  diagnostic: BrowserConsoleDiagnostic,
  sandboxSelfhostedEnabled: boolean,
  expectedResponseUrls: ReadonlySet<string>,
): boolean {
  return (
    !sandboxSelfhostedEnabled &&
    disabledMachinesConsoleError.test(diagnostic.text) &&
    expectedResponseUrls.has(diagnostic.locationUrl)
  );
}
