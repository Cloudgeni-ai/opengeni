export const SIGN_IN_METHOD_ORIGIN_MESSAGE =
  "Account security is unavailable because this deployment connects to the API on a different origin. Ask the administrator to serve the website and API through the same origin, then reload this page.";

export function signInMethodsHaveSameOrigin(apiBaseUrl: string, pageUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const api = new URL(apiBaseUrl || ".", page);
    return page.origin !== "null" && api.origin === page.origin;
  } catch {
    return false;
  }
}
