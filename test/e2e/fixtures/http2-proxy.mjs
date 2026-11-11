// Real browser HTTP/2 transport for the sidebar notification acceptance test.
// Run with Node: Bun serves the application behind this TLS-terminating proxy.
import { createSecureServer } from "node:http2";
import { request } from "node:http";
import { readFileSync } from "node:fs";

const [port, apiPort, webPort, keyFile, certFile] = process.argv.slice(2);
const hopHeaders = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);
const server = createSecureServer({ key: readFileSync(keyFile), cert: readFileSync(certFile), allowHTTP1: true });
// Compatibility requests serve both the HTTP/1 fixture client and Chromium h2.
server.on("request", (incoming, outgoing) => {
  const path = incoming.url;
  const api = path.startsWith("/v1/") || path === "/healthz" || path === "/readyz";
  const forwarded = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) =>
    !name.startsWith(":") && !hopHeaders.has(name)));
  const upstream = request({ hostname: "127.0.0.1", port: api ? apiPort : webPort,
    path, method: incoming.method, headers: forwarded }, (response) => {
    if (outgoing.destroyed) { response.destroy(); return; }
    const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([name]) =>
      !hopHeaders.has(name)));
    outgoing.writeHead(response.statusCode, responseHeaders);
    response.pipe(outgoing);
    outgoing.on("close", () => response.destroy());
    response.on("error", () => outgoing.destroy());
  });
  outgoing.on("close", () => upstream.destroy());
  incoming.on("aborted", () => upstream.destroy());
  incoming.on("error", () => upstream.destroy());
  upstream.on("error", () => outgoing.destroy());
  incoming.pipe(upstream);
});
server.listen(Number(port), "127.0.0.1", () => console.log("HTTP/2 fixture ready"));
