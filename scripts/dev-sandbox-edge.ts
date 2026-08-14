import { createServer, request as upstreamRequest } from "node:http";

const port = Number.parseInt(Bun.env.OPENGENI_SANDBOX_EDGE_PORT ?? "", 10);
const api = new URL(Bun.env.OPENGENI_SANDBOX_EDGE_API_ORIGIN ?? "");
const objects = new URL(Bun.env.OPENGENI_SANDBOX_EDGE_OBJECT_ORIGIN ?? "");

if (!Number.isInteger(port) || port <= 0) {
  throw new Error("OPENGENI_SANDBOX_EDGE_PORT must be a positive integer");
}

const server = createServer((incoming, outgoing) => {
  const incomingUrl = new URL(incoming.url ?? "/", "http://opengeni.local");
  if (incomingUrl.pathname === "/__opengeni_edge_health") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end('{"ok":true}');
    return;
  }

  const origin = /^\/v1(?:\/|$)/u.test(incomingUrl.pathname) ? api : objects;
  const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin);
  const request = upstreamRequest(
    target,
    {
      method: incoming.method,
      // Preserve the public Host header. MinIO includes it in presigned-request
      // verification; replacing it with loopback would invalidate every URL.
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  request.on("error", (error) => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { "content-type": "application/json" });
    }
    outgoing.end(
      JSON.stringify({ error: "development upstream unavailable", detail: error.message }),
    );
  });
  incoming.pipe(request);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OpenGeni sandbox development edge listening on 127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
