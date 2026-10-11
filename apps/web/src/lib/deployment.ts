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
 * The universal install-or-connect one-liner. The installer is idempotent,
 * `connect` adds only this deployment/workspace, and the agent is left running
 * as the ordinary background service. It is safe on a machine already serving
 * other Opengeni instances.
 *
 * It ALWAYS bakes `OPENGENI_API_URL=${origin}` so the agent targets *this*
 * deployment rather than relying on the managed-cloud fallback. Pass:
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

/**
 * The PowerShell counterpart of {@link installOneLiner} for Windows, with the
 * same origin pinning. Values are single-quoted so PowerShell never expands them.
 */
export function installOneLinerWindows(
  baseUrl: string,
  opts?: { workspaceId?: string; enrollToken?: string },
): string {
  const origin = originOf(baseUrl);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const env = [`$env:OPENGENI_API_URL=${quote(origin)}`];
  if (opts?.workspaceId) {
    env.push(`$env:OPENGENI_WORKSPACE_ID=${quote(opts.workspaceId)}`);
  }
  if (opts?.enrollToken) {
    env.push(`$env:OPENGENI_ENROLL_TOKEN=${quote(opts.enrollToken)}`);
  }
  return `${env.join("; ")}; irm ${quote(`${origin}/install.ps1`)} | iex`;
}

export type ConnectPlatform = "unix" | "windows";

/** The platform a connect command should target by default for this browser. */
export function detectConnectPlatform(userAgent: string | undefined): ConnectPlatform {
  return userAgent && /windows/i.test(userAgent) ? "windows" : "unix";
}
