/**
 * Where the dev server forwards `/v1`: the configured API, unless that is this
 * server itself. Pointing VITE_API_BASE_URL at the web origin makes the
 * browser talk to the API through the dev server, same-origin as in
 * production, which managed-mode browser mutations (connecting Codex,
 * SuperGrok) require.
 */
export function devApiProxyTarget(
  configured: string | undefined,
  apiPort: string | undefined,
  webPort = 3000,
): string {
  const loopback = `http://127.0.0.1:${apiPort || 8000}`;
  if (!configured) return loopback;
  try {
    const url = new URL(configured);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return port === String(webPort) ? loopback : configured;
  } catch {
    return loopback;
  }
}
