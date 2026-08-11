// Local-dev helper for testing the Fiken OAuth flow through an HTTPS tunnel.
// Fiken rejects non-HTTPS redirect URLs, but tunneling the whole local API
// would expose an auth-free `local`-mode deployment; this forwarder accepts
// only the exact browser-redirect callback path and rejects everything else,
// so the tunnel can safely point here instead of at the API.
//
// Usage: bun scripts/dev-fiken-callback-forwarder.ts <api-port> [listen-port]
// then: ngrok http <listen-port>, and set OPENGENI_PUBLIC_BASE_URL to the
// tunnel URL so start/callback build a consistent redirect_uri.

const apiPort = Number.parseInt(process.argv[2] ?? "", 10);
const listenPort = Number.parseInt(process.argv[3] ?? "9010", 10);
if (!Number.isInteger(apiPort) || apiPort <= 0) {
  console.error("usage: bun scripts/dev-fiken-callback-forwarder.ts <api-port> [listen-port]");
  process.exit(1);
}

Bun.serve({
  hostname: "127.0.0.1",
  port: listenPort,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/integrations/fiken/callback") {
      return new Response("not found", { status: 404 });
    }
    const upstream = new URL(`http://127.0.0.1:${apiPort}${url.pathname}${url.search}`);
    const response = await fetch(upstream, { redirect: "manual" });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
});

console.log(
  `forwarding GET /v1/integrations/fiken/callback from 127.0.0.1:${listenPort} to 127.0.0.1:${apiPort}`,
);
