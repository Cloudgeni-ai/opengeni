// Runs as root of a private user + network namespace (see
// cdp-network-change-navigation.e2e.test.ts), given the path of `ip`. Navigates a managed tab to an
// address that is routed but not answering yet, so the browser is still
// connecting, then makes that address local. Adding the address is an
// interface address change: Chromium on Linux cancels every load still
// connecting with net::ERR_NETWORK_CHANGED, the same as when a container's
// bridge comes or goes on the machine. Prints the navigate's outcome.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowserDriver } from "../../src/cdp-driver";
import { ManagedBrowserRunner } from "../../src/runner";

const [ip] = process.argv.slice(2) as [string];
const run = (...args: string[]) => {
  const result = spawnSync(ip, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ip ${args.join(" ")}: ${result.stderr}`);
};
// The destination is routed out of an interface where nothing answers, so a
// connection to it stays pending until its address becomes local.
const destination = "198.51.100.7";
run("link", "set", "lo", "up");
run("tuntap", "add", "mode", "tun", "name", "up0");
run("link", "set", "up0", "up");
run("addr", "add", "192.0.2.10/24", "dev", "up0");
run("route", "add", "default", "dev", "up0");

let requests = 0;
const server = createServer((request, response) => {
  if (request.url === "/") requests += 1;
  response.setHeader("content-type", "text/html");
  response.end("<title>Loaded</title><p>Loaded after the network change</p>");
});
await new Promise<void>((resolveListen) => server.listen(0, "0.0.0.0", resolveListen));
const port = (server.address() as { port: number }).port;

const directory = await mkdtemp(join(tmpdir(), "og-network-change-"));
const runner = await ManagedBrowserRunner.create({
  profileDirectory: join(directory, "profile"),
  headed: false,
  systemdScope: false,
  networkIsolation: false,
  ...(process.env.OPENGENI_BROWSER_EXECUTABLE
    ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
    : {}),
});
const driver = new AgentBrowserDriver({
  browserSessionId: randomUUID(),
  controllerGeneration: randomUUID(),
  runner,
});
try {
  const initial = await driver.start("data:text/html,<title>Before</title><p>Before</p>");
  const navigation = driver.dispatch({
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: initial.browserSessionId,
    controllerGeneration: initial.target.controllerGeneration,
    targetId: initial.target.id,
    expectedTargetGeneration: initial.target.targetGeneration,
    expectedDocumentGeneration: initial.target.documentGeneration,
    expectedFrameId: initial.frameId!,
    actor: { kind: "agent", subjectId: "browserd-network-change-e2e" },
    action: { type: "navigate", url: `http://${destination}:${port}/` },
  });
  const outcome = navigation.then(
    (observation) => ({ state: "completed", title: observation.target.title }),
    (error: unknown) => ({
      state: "failed",
      code: (error as { code?: string }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  // Let the browser start connecting, then change the network under it.
  await Bun.sleep(1_000);
  run("addr", "add", `${destination}/32`, "dev", "lo");
  console.log(JSON.stringify({ ...(await outcome), requests }));
} finally {
  await driver.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
