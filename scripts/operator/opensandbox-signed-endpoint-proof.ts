/**
 * Dossier §16 / §22 Channel B signed-endpoint proof.
 *
 * Mints OSEP-0011 signed URIs against a live OpenSandbox box and proves:
 *   - JSON host-fetch forwards the browserd Bearer (not lifecycle `/proxy/`)
 *   - native WebSocket subprotocols survive URI-mode ingress
 *
 * Requires preview ClusterIP lifecycle + ingress port-forwards.
 * Writes a redacted JSON artifact; never log signatures or browserd tokens.
 */
import { readFile, writeFile } from "node:fs/promises";
import { Manifest } from "@openai/agents/sandbox";
import {
  OpenSandboxClient,
  OpenSandboxSession,
  isOpenSandboxLifecycleProxyPath,
  parseOpenSandboxSignedUriPath,
  redactOpenSandboxSignedUriPath,
  runWithToolCallCorrelation,
} from "@opengeni/runtime/sandbox";

const IMAGE =
  process.env.OPENGENI_OPENSANDBOX_IMAGE ??
  "ogosbpreview1c91.azurecr.io/opengeni-sandbox@sha256:2723fb371ae8de327f50fa0b10a33fdc921056afabfdacc22c804d9924e614c6";
const BASE_URL = process.env.OPENGENI_OPENSANDBOX_BASE_URL ?? "http://127.0.0.1:18090";
const PUBLIC_BASE = process.env.OPENGENI_OPENSANDBOX_CHANNEL_B_PUBLIC_BASE_URL ?? "http://127.0.0.1:28888";
const BEARER = "m2-browserd-token";
const SUBPROTOCOL = "opengeni.test.subprotocol";
const OUT = ".agent/generated/opensandbox/signed-endpoint-proof.json";

async function apiKey(): Promise<string> {
  if (process.env.OPENGENI_OPENSANDBOX_API_KEY) return process.env.OPENGENI_OPENSANDBOX_API_KEY;
  return (
    await readFile(`${process.env.HOME}/.opengeni-opensandbox-preview-20260819.api-key`, "utf8")
  ).trim();
}

function redactPath(path: string): string {
  return redactOpenSandboxSignedUriPath(path);
}

function isLifecycleProxy(path: string): boolean {
  return isOpenSandboxLifecycleProxyPath(path);
}

function isSignedUri(path: string): boolean {
  return parseOpenSandboxSignedUriPath(path) !== null;
}

async function retry<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await Bun.sleep(500);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const HTTP_PY = `
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if auth != "Bearer ${BEARER}":
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b"unauthorized")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')
    def log_message(self, format, *args):
        return
HTTPServer(("0.0.0.0", 8080), H).serve_forever()
`;

const WS_PY = `
import asyncio, base64, hashlib
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
async def handle(reader, writer):
    data = b""
    while b"\\r\\n\\r\\n" not in data:
        chunk = await reader.read(1024)
        if not chunk:
            return
        data += chunk
    headers = {}
    for line in data.decode("iso-8859-1").split("\\r\\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    key = headers.get("sec-websocket-key", "")
    proto = headers.get("sec-websocket-protocol")
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    extra = f"Sec-WebSocket-Protocol: {proto}\\r\\n" if proto else ""
    writer.write(
        (
            "HTTP/1.1 101 Switching Protocols\\r\\n"
            "Upgrade: websocket\\r\\n"
            "Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Accept: {accept}\\r\\n"
            f"{extra}\\r\\n"
        ).encode()
    )
    await writer.drain()
    payload = b"ok"
    writer.write(bytes([0x81, len(payload)]) + payload)
    await writer.drain()
    writer.close()
async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", 8765)
    await server.serve_forever()
asyncio.run(main())
`;

const key = await apiKey();
const client = new OpenSandboxClient({
  baseUrl: BASE_URL,
  apiKey: key,
  image: IMAGE,
  ttlSeconds: 900,
  useServerProxy: true,
  signedEndpoints: true,
  signedEndpointTtlSeconds: 600,
  channelBPublicBaseUrl: PUBLIC_BASE,
  readyTimeoutSeconds: 180,
  resourceLimits: { cpu: "2", memory: "4Gi" },
  resourceRequests: { cpu: "500m", memory: "2Gi" },
  exposedPorts: [8080, 8765],
});

const startedAt = new Date().toISOString();
const steps: Array<Record<string, unknown>> = [];
let sandboxId: string | null = null;
let session: OpenSandboxSession | null = null;

async function step(id: string, fn: () => Promise<Record<string, unknown>>): Promise<boolean> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    steps.push({ id, status: "passed", durationMs: Math.round(performance.now() - t0), ...detail });
    return true;
  } catch (error) {
    steps.push({
      id,
      status: "failed",
      durationMs: Math.round(performance.now() - t0),
      error: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800),
    });
    return false;
  }
}

try {
  const created = await step("create-secureAccess", async () => {
    session = await client.create({
      manifest: new Manifest({ entries: { "seed.txt": { type: "file", content: "seed" } } }),
    });
    sandboxId = session.state.sandboxId;
    await session.start();
    return { sandboxId };
  });
  if (created && session) {
  await step("start-http-auth-server", async () => {
    await session!.writeFile({ path: "m2-http.py", content: HTTP_PY });
    const retained = await runWithToolCallCorrelation("m2-http", () =>
      session!.exec({ cmd: "python3 /workspace/m2-http.py", yieldTimeMs: 0 }),
    );
    if (retained.sessionId === undefined) throw new Error("HTTP server did not yield");
    return { sessionId: retained.sessionId };
  });
  await step("start-ws-subprotocol-server", async () => {
    await session!.writeFile({ path: "m2-ws.py", content: WS_PY });
    const retained = await runWithToolCallCorrelation("m2-ws", () =>
      session!.exec({ cmd: "python3 /workspace/m2-ws.py", yieldTimeMs: 0 }),
    );
    if (retained.sessionId === undefined) throw new Error("WS server did not yield");
    return { sessionId: retained.sessionId };
  });
  await step("signed-http-authorization", async () => {
    const endpoint = await session!.resolveExposedPort(8080);
    const url = endpoint.url!;
    const path = new URL(url).pathname;
    if (isLifecycleProxy(path)) throw new Error(`lifecycle proxy path ${path}`);
    if (!isSignedUri(path)) throw new Error(`not OSEP URI: ${path}`);
    if (new URL(url).host !== "127.0.0.1:28888") throw new Error(`host rewrite failed: ${url}`);
    const denied = await retry(30_000, async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status !== 401) throw new Error(`expected 401 without bearer, got ${response.status}`);
      return response.status;
    });
    const allowed = await retry(15_000, async () => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${BEARER}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.text();
      if (!response.ok || !body.includes('"ok":true')) {
        throw new Error(`bearer fetch failed ${response.status} ${body.slice(0, 200)}`);
      }
      return body;
    });
    return {
      path: redactPath(path),
      unauthorizedStatus: denied,
      authorizedBody: allowed,
      lifecycleProxy: false,
    };
  });
  await step("signed-websocket-subprotocol", async () => {
    const endpoint = await session!.resolveExposedPort(8765);
    const url = endpoint.url!.replace(/^http/u, "ws");
    const path = new URL(url).pathname;
    if (isLifecycleProxy(path)) throw new Error(`lifecycle proxy path ${path}`);
    if (!isSignedUri(path)) throw new Error(`not OSEP URI: ${path}`);
    const result = await retry(30_000, async () => {
      return await new Promise<{ protocol: string; message: string }>((resolve, reject) => {
        const ws = new WebSocket(url, [SUBPROTOCOL]);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("websocket timeout"));
        }, 8_000);
        ws.addEventListener("open", () => {
          /* wait for payload */
        });
        ws.addEventListener("message", (event) => {
          clearTimeout(timer);
          const message = typeof event.data === "string" ? event.data : String(event.data);
          const protocol = ws.protocol;
          ws.close();
          resolve({ protocol, message });
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error(`websocket error protocol=${ws.protocol}`));
        });
      });
    });
    if (result.protocol !== SUBPROTOCOL) {
      throw new Error(`subprotocol not preserved: ${result.protocol || "<empty>"}`);
    }
    return { path: redactPath(path), ...result };
  });
  }
} finally {
  await (session as OpenSandboxSession | null)?.delete().catch(() => undefined);
}

const passed = steps.length > 0 && steps.every((entry) => entry.status === "passed");
const artifact = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  sandboxId,
  publicBase: PUBLIC_BASE,
  lifecycleBase: BASE_URL,
  steps,
  passed,
  decision: passed
    ? "OpenSandbox JPEG/RFB attachments can use native WebSocket subprotocols; do not keep the API frame-proxy for signed Channel B."
    : "Keep the API frame-proxy for OpenSandbox streams if the websocket step failed; still ship JSON host-fetch if HTTP Authorization passed.",
};
await writeFile(OUT, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(artifact, null, 2));
if (!passed) process.exitCode = 2;
