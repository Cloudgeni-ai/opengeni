// Loads pages from host loopback servers of every listening shape (IPv4 only,
// IPv6 only, 0.0.0.0, dual-stack ::), started before and after the browser
// launched, through localhost, 127.0.0.1 and [::1], and prints what each URL
// showed. The regression test compares the isolated browser with one sharing
// the machine's network: nothing that loads today may stop loading.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedBrowserRunner } from "../../src/runner";

const mode = process.argv[2] as "isolated" | "shared";
const shapes = [
  ["ipv4", "127.0.0.1"],
  ["ipv6", "::1"],
  ["any4", "0.0.0.0"],
  ["dual", "::"],
] as const;
const servers: Server[] = [];
const listen = async (label: string, host: string) => {
  const server = createServer((_request, response) => response.end(label));
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, ipv6Only: host === "::1" }, resolveListen);
  });
  servers.push(server);
  return { label, port: (server.address() as { port: number }).port };
};

const targets = [];
for (const [shape, host] of shapes) targets.push(await listen(`${shape} before`, host));
const root = await mkdtemp(join(tmpdir(), `og-reachability-${mode}-`));
const runner = await ManagedBrowserRunner.create({
  profileDirectory: join(root, "profile"),
  headed: false,
  systemdScope: false,
  networkIsolation: mode === "isolated",
  ...(process.env.OPENGENI_BROWSER_EXECUTABLE
    ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
    : {}),
});
try {
  await runner.run(["open", "about:blank"]);
  for (const [shape, host] of shapes) targets.push(await listen(`${shape} after`, host));
  // Servers started after launch are picked up within a second.
  await Bun.sleep(1_500);
  const { cdpUrl } = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
  const pages = (await (
    await fetch(`http://127.0.0.1:${new URL(cdpUrl).port}/json`)
  ).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = pages.find((entry) => entry.type === "page");
  if (!page) throw new Error("the browser has no page target");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen) => socket.addEventListener("open", resolveOpen));
  let nextId = 0;
  const send = async <T>(method: string, params: object) =>
    await new Promise<T>((resolveSend) => {
      const id = (nextId += 1);
      socket.addEventListener("message", function listener(event) {
        const message = JSON.parse(String(event.data)) as { id?: number; result: T };
        if (message.id !== id) return;
        socket.removeEventListener("message", listener);
        resolveSend(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const results: Record<string, string> = {};
  for (const { label, port } of targets) {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const navigation = await send<{ errorText?: string }>("Page.navigate", {
        url: `http://${host}:${port}/`,
      });
      if (navigation.errorText) {
        results[`${label} via ${host}`] = "fails";
        continue;
      }
      await send("Runtime.evaluate", {
        expression: "new Promise((done) => document.readyState === 'complete' ? done() : addEventListener('load', done))",
        awaitPromise: true,
      });
      const body = await send<{ result?: { value?: string } }>("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      });
      results[`${label} via ${host}`] = body.result?.value === label ? "loads" : "fails";
    }
  }
  socket.close();
  console.log(JSON.stringify({ mode, notice: runner.networkNotice, results }));
} finally {
  await runner.terminate();
  for (const server of servers) server.close();
  await rm(root, { recursive: true, force: true });
}
