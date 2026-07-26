// Deployment-relative URLs for the bring-your-own-compute enrollment flow. The
// console is served from the same origin as its API, so the install one-liner
// and device-approval page live there — never a hardcoded `get.opengeni.ai`.
// Both helpers are tiny and pure; pass the resolved API base URL (or
// `window.location.origin`).

/** Trim a single trailing slash so we can append clean `/paths`. */
function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The install one-liner the user runs on the machine they want to enroll.
 *
 * It ALWAYS bakes `OPENGENI_API_URL=${origin}` so the agent targets *this*
 * deployment rather than the hardcoded `api.opengeni.ai` default. Pass:
 *  - `{ workspaceId }` for the interactive (human device-approve) path — adds
 *    `OPENGENI_WORKSPACE_ID` so the user never hand-types the workspace UUID.
 *  - `{ enrollToken }` for the headless / fleet path — adds
 *    `OPENGENI_ENROLL_TOKEN` (a short-lived secret) so the machine enrolls with
 *    zero approve clicks.
 *  - nothing — the bare interactive install (still origin-pinned).
 */
export function installOneLiner(
  baseUrl: string,
  opts?: { workspaceId?: string; enrollToken?: string },
): string {
  const origin = originOf(baseUrl);
  const env = [`OPENGENI_API_URL=${origin}`];
  if (opts?.workspaceId) {
    env.push(`OPENGENI_WORKSPACE_ID=${opts.workspaceId}`);
  }
  if (opts?.enrollToken) {
    env.push(`OPENGENI_ENROLL_TOKEN=${opts.enrollToken}`);
  }
  return `curl -fsSL ${origin}/install.sh | ${env.join(" ")} sh`;
}

/** The same-origin device-flow approval page. */
export function deviceVerificationUri(baseUrl: string): string {
  return `${originOf(baseUrl)}/device`;
}
