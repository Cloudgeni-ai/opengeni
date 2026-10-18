// Runs inside the churn regression test's private namespaces. Launches a
// managed browser (isolated or sharing the network), loads a page from a
// loopback HTTP/1.1 server, waits while the harness adds an address on an
// unrelated interface, then reports whether the browser kept its idle
// keep-alive connection. Chromium drops idle connections on every IP address
// change it observes (and closes HTTP/2 and QUIC sessions outright), so a
// fresh connection after the churn means the change reached the browser.
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { AgentBrowserJsonRunner } from "../../src/runner";

const [mode, directory] = process.argv.slice(2) as ["isolated" | "shared", string];
let connections = 0;
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(request.url === "/" ? "<title>churn</title>ok" : String(connections));
});
server.keepAliveTimeout = 120_000;
server.on("connection", () => (connections += 1));
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const port = (server.address() as { port: number }).port;

const root = await mkdtemp(join(directory, `${mode}-`));
const socketDirectory = await mkdtemp("/tmp/og-churn-");
const runner = await AgentBrowserJsonRunner.create({
  namespace: "og",
  sessionName: mode,
  socketDirectory,
  profileDirectory: join(root, "profile"),
  downloadDirectory: join(root, "downloads"),
  screenshotDirectory: join(root, "screenshots"),
  headed: false,
  systemdScope: false,
  networkIsolation: mode === "isolated",
  ...(process.env.OPENGENI_BROWSER_EXECUTABLE
    ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
    : {}),
});
try {
  await runner.run(["open", `http://127.0.0.1:${port}/`]);
  const { cdpUrl } = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
  const pages = (await (
    await fetch(`http://127.0.0.1:${new URL(cdpUrl).port}/json`)
  ).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = pages.find((entry) => entry.type === "page" && entry.url.includes(String(port)));
  if (!page) throw new Error("the loaded page has no DevTools target");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen) => socket.addEventListener("open", resolveOpen));
  const fetchCount = async () =>
    await new Promise<void>((resolveFetch, reject) => {
      socket.addEventListener("message", function listener(event) {
        const message = JSON.parse(String(event.data)) as {
          id: number;
          result?: { result?: { value?: string } };
        };
        if (message.id !== 1) return;
        socket.removeEventListener("message", listener);
        if (message.result?.result?.value?.startsWith("ok")) resolveFetch();
        else reject(new Error(`page fetch failed: ${JSON.stringify(message)}`));
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression:
              "fetch('/count', { cache: 'no-store' }).then((r) => 'ok ' + r.status).catch((e) => 'error ' + e.message)",
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    });
  await fetchCount();
  const before = connections;
  await writeFile(join(directory, "ready"), "");
  for (let attempt = 0; !existsSync(join(directory, "churned")); attempt += 1) {
    if (attempt > 200) throw new Error("the harness did not change the network");
    await Bun.sleep(25);
  }
  await Bun.sleep(500);
  await fetchCount();
  socket.close();
  console.log(
    JSON.stringify({ mode, notice: runner.networkNotice, keptConnection: connections === before }),
  );
} finally {
  await runner.terminate();
  server.close();
  await rm(socketDirectory, { recursive: true, force: true });
}
