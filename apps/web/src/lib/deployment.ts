// Deployment-relative URLs for the bring-your-own-compute enrollment flow. The
// console is served from the same origin as its API, so the install one-liner
// and device-approval page live there — never a hardcoded `get.opengeni.ai`.
// Both helpers are tiny and pure; pass the resolved API base URL (or
// `window.location.origin`).

/** Trim a single trailing slash so we can append clean `/paths`. */
function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The install one-liner the user runs on the machine they want to enroll. */
export function installOneLiner(baseUrl: string): string {
  return `curl -fsSL ${originOf(baseUrl)}/install.sh | sh`;
}

/** The same-origin device-flow approval page. */
export function deviceVerificationUri(baseUrl: string): string {
  return `${originOf(baseUrl)}/device`;
}
