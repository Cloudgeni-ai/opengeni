import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { resolvePinnedHeadlessShell } from "../src/headless-shell";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  BrowserSupervisor,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
} from "../src";
import {
  clickFirstButton,
  openManagedRecoverySupervisor,
  semanticNames,
} from "./fixtures/managed-recovery-fixture";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// Positive directory recovery needs a complete process inventory and the exact
// Chromium executable. CI runs this separately in an owned PID namespace.
const recoveryE2e =
  process.platform === "linux" && process.env.OPENGENI_BROWSERD_RECOVERY_E2E === "1"
    ? e2e
    : test.skip;

// "graceful": the controller shuts down as for an upgrade or service restart.
// "killed": the controller, its launcher daemon and Chrome's stderr drain are
// killed outright, as a service stop does to everything left in its cgroup.
// "stopped": the controller runs as a systemd user service with the native
// agent's KillMode and that service is stopped; the browser it launched lives
// in its own scope and keeps every process. Needs a user service manager.
// Headed modes run when a display is available (for example, under Xvfb).
const userServiceManager =
  process.platform === "linux" &&
  spawnSync("busctl", [
    "--user",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.DBus.Peer",
    "Ping",
  ]).status === 0;
const recoveryEndings = userServiceManager
  ? (["graceful", "killed", "stopped"] as const)
  : (["graceful", "killed"] as const);
const recoveryCases = recoveryEndings.flatMap((ending) =>
  (process.env.DISPLAY ? [false, true] : [false]).map((headed) => ({ ending, headed })),
);
recoveryE2e.each(recoveryCases)(
  "a $ending controller leaves the same live browser and unsaved page state (headed: $headed)",
  async ({ ending, headed }) => {
    const directory = await mkdtemp("/tmp/ogb-recovery-e2e-");
    const socketRootDirectory = await mkdtemp("/tmp/ogg-");
    const rootDirectory = join(directory, "state");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><title>Recovery fixture</title>
      <button id="counter">Counter</button><p id="cookie"></p><p id="live"></p><script>
        let unsaved = 0;
        const render = () => {
          counter.textContent = 'Counter ' + (localStorage.getItem('count') || '0');
          cookie.textContent = 'Cookie ' + (document.cookie || 'empty');
          live.textContent = 'Unsaved ' + unsaved;
        };
        counter.onclick = () => {
          const count = Number(localStorage.getItem('count') || '0') + 1;
          localStorage.setItem('count', String(count));
          document.cookie = 'counter=' + count + '; Max-Age=3600; Path=/';
          unsaved += 1;
          render();
        }; render();
      </script>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const options = {
      ...reference(),
      headed,
      initialUrl: `http://127.0.0.1:${server.port}/`,
      browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE ?? "/usr/bin/chromium",
      workingRuntimeAuthority: {
        tokenGeneration: 1,
        placementDigest: "a".repeat(64),
        controlDigest: "b".repeat(64),
        viewDigest: "c".repeat(64),
      },
    };
    const profile = join(rootDirectory, "sessions", options.browserSessionId, "profile");
    let first: BrowserSupervisor | undefined;
    let second: BrowserSupervisor | undefined;
    let controller: ReturnType<typeof Bun.spawn> | undefined;
    let controllerUnit: string | undefined;
    let browserPid: number | undefined;
    const failures: unknown[] = [];
    try {
      if (ending === "graceful") {
        first = await openManagedRecoverySupervisor(rootDirectory, socketRootDirectory);
        const created = await first.createSession(options);
        const clicked = await first.action(clickFirstButton(created.observation));
        expect(clicked.state).toBe("completed");
        expect(semanticNames(clicked.observation!)).toContain("Unsaved 1");
        browserPid = await chromiumProfilePid(profile);
        await first.close();
      } else if (ending === "killed") {
        controller = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "fixtures", "managed-recovery-fixture.ts"),
            JSON.stringify({ rootDirectory, socketRootDirectory, options }),
          ],
          { stdout: "pipe", stderr: "inherit" },
        );
        const line = await firstLine(controller.stdout as ReadableStream<Uint8Array>, 30_000);
        const clicked = JSON.parse(line) as { state: string; names: string[] };
        expect(clicked.state).toBe("completed");
        expect(clicked.names).toContain("Unsaved 1");
        browserPid = await chromiumProfilePid(profile);
        const launcher = await parentPid(browserPid);
        const drains = await childPids(browserPid, "tail");
        for (const pid of [controller.pid, launcher, ...drains]) process.kill(pid, "SIGKILL");
        await controller.exited;
        for (const pid of [launcher, ...drains]) await waitForProcessDeath(pid);
      } else {
        controllerUnit = `ogb-controller-${randomUUID()}.service`;
        controller = Bun.spawn(
          [
            "systemd-run",
            "--user",
            "--quiet",
            "--collect",
            "--pipe",
            "--same-dir",
            `--unit=${controllerUnit}`,
            "--property=KillMode=mixed",
            ...Object.keys(process.env)
              .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
              .map((key) => `--setenv=${key}`),
            "--",
            process.execPath,
            join(import.meta.dir, "fixtures", "managed-recovery-fixture.ts"),
            JSON.stringify({ rootDirectory, socketRootDirectory, options }),
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
        );
        const line = await firstLine(controller.stdout as ReadableStream<Uint8Array>, 30_000);
        const clicked = JSON.parse(line) as { state: string; names: string[] };
        expect(clicked.state).toBe("completed");
        expect(clicked.names).toContain("Unsaved 1");
        browserPid = await chromiumProfilePid(profile);
        const browserTree = [browserPid, ...(await descendantPids(browserPid))];
        expect(browserTree.length).toBeGreaterThan(2);
        // The whole browser tree, including the process Chromium itself moves
        // into an app scope at startup, is in the browser's own scope.
        const scope = await processUnit(browserPid);
        expect(scope).toMatch(/\/opengeni-browsers\.slice\/opengeni-browser-[^/]+\.scope$/u);
        for (const pid of browserTree) expect(await processUnit(pid)).toBe(scope);
        expect(spawnSync("systemctl", ["--user", "stop", controllerUnit]).status).toBe(0);
        await controller.exited;
        for (const pid of browserTree) expect(() => process.kill(pid, 0)).not.toThrow();
      }
      // The controller is gone; the browser it launched is not.
      const inode = (await stat(profile)).ino;
      expect(() => process.kill(browserPid!, 0)).not.toThrow();
      second = await openManagedRecoverySupervisor(rootDirectory, socketRootDirectory);
      const { initialUrl, ...recoveryOptions } = options;
      const recovered = await second.createSession({
        ...recoveryOptions,
        recoverExistingWorkingDirectory: true,
      });
      expect(recovered.browserSessionId).toBe(options.browserSessionId);
      expect(recovered.controllerGeneration).toBe(options.controllerGeneration);
      expect((await stat(profile)).ino).toBe(inode);
      expect(await chromiumProfilePid(profile)).toBe(browserPid);
      // The original document was never reloaded: in-memory state survived.
      const targets = await second.listTargets(options);
      expect(targets).toHaveLength(1);
      const kept = await second.observe(options, targets[0]!.id);
      expect(semanticNames(kept)).toContain("Unsaved 1");
      const again = await second.action(clickFirstButton(kept));
      expect(again.state).toBe("completed");
      expect(semanticNames(again.observation!)).toContain("Unsaved 2");
      const page = await second.openTarget(options, initialUrl);
      expect(semanticNames(page)).toContain("Counter 2");
      expect(semanticNames(page).join(" ")).toContain("Cookie counter=2");
      await second.endSession(options, { removeState: true });
      // After a killed controller, Chromium is reparented to this PID namespace's
      // init (the test runner), which does not reap it: a zombie counts as gone.
      await waitForProcessDeath(browserPid);
    } catch (error) {
      failures.push(error);
      if (browserPid) {
        try {
          process.kill(browserPid, "SIGKILL");
        } catch {}
      }
    } finally {
      if (controller?.exitCode === null) controller.kill("SIGKILL");
      if (controllerUnit) spawnSync("systemctl", ["--user", "stop", controllerUnit]);
      const cleanup = await Promise.allSettled([first?.close(), second?.close()]);
      server.stop(true);
      const cleanupFailures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      failures.push(...cleanupFailures);
      if (!cleanupFailures.length) {
        await rm(directory, { recursive: true, force: true });
        await rm(socketRootDirectory, { recursive: true, force: true });
      }
    }
    if (failures.length) throw new AggregateError(failures, "managed recovery fixture failed");
  },
  90_000,
);

e2e("runs multiple real browser sessions through one placement supervisor", async () => {
  const directory = await mkdtemp("/tmp/ogb-supervisor-e2e-");
  const socketDirectory = await mkdtemp("/tmp/ogs-");
  const headlessShell = process.env.OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY
    ? await resolvePinnedHeadlessShell(process.env.OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY)
    : undefined;
  const supervisor = await BrowserSupervisor.open({
    ...(headlessShell ? { headlessShell } : {}),
    rootDirectory: join(directory, "state"),
    socketRootDirectory: socketDirectory,
  });
  const first = reference();
  const second = reference();
  try {
    const [one, two] = await Promise.all([
      supervisor.createSession({
        ...first,
        headed: false,
        initialUrl: fixture("One"),
      }),
      supervisor.createSession({
        ...second,
        headed: false,
        initialUrl: fixture("Two"),
      }),
    ]);
    expect(supervisor.listSessions()).toHaveLength(2);
    const [oneClicked, twoClicked] = await Promise.all([
      supervisor.action(clickCommand(one.observation)),
      supervisor.action(clickCommand(two.observation)),
    ]);
    expect(oneClicked.state).toBe("completed");
    expect(twoClicked.state).toBe("completed");
    expect(names(oneClicked.observation!)).toContain("One clicked");
    expect(names(twoClicked.observation!)).toContain("Two clicked");

    const firstState = join(directory, "state", "sessions", first.browserSessionId);
    await supervisor.endSession(first, { removeState: true });
    expect(await exists(firstState)).toBe(false);
    expect(await supervisor.listTargets(second)).toHaveLength(1);
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  }
});

e2e.each(["read", "capture"] as const)(
  "recovers after exact Chromium process loss before %s without reusing target refs",
  async (operation) => {
    const directory = await mkdtemp("/tmp/ogb-browser-loss-e2e-");
    const socketDirectory = await mkdtemp("/tmp/ogl-");
    let driverLifecycles = 0;
    let uploads = 0;
    let profileDirectory: string | undefined;
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: join(directory, "state"),
      socketRootDirectory: socketDirectory,
      uploadArtifact: async (path) => {
        expect((await stat(path)).size).toBeGreaterThan(0);
        uploads += 1;
      },
      createDriver: async (driverContext) => {
        profileDirectory = driverContext.profileDirectory;
        driverLifecycles += 1;
        const runner = await AgentBrowserJsonRunner.create({
          namespace: "og",
          sessionName: `r${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          socketDirectory: driverContext.socketDirectory,
          profileDirectory: driverContext.profileDirectory,
          downloadDirectory: driverContext.downloadDirectory,
          screenshotDirectory: driverContext.screenshotDirectory,
          headed: false,
          browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE ?? "/usr/bin/chromium",
        });
        return new AgentBrowserDriver({
          browserSessionId: driverContext.browserSessionId,
          controllerGeneration: driverContext.controllerGeneration,
          runner,
          downloadDirectory: driverContext.downloadDirectory,
          ...(driverContext.downloadEvents ? { downloadEvents: driverContext.downloadEvents } : {}),
          resolveWorkspaceFiles: driverContext.resolveWorkspaceFiles,
        });
      },
    });
    const session = reference();
    try {
      const created = await supervisor.createSession({
        ...session,
        headed: false,
        initialUrl: fixture("Recovery"),
      });
      if (!profileDirectory) throw new Error("browser driver context missing");
      const browserPid = await chromiumProfilePid(profileDirectory);
      process.kill(browserPid, "SIGKILL");
      await waitForProcessExit(browserPid);

      if (operation === "capture") {
        const operationId = randomUUID();
        const input = {
          ...session,
          operationId,
          objectKey: `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/checkpoints/${operationId}/chromium-profile.ogbs`,
          afterCapture: "restart" as const,
          dataKey: Buffer.alloc(32, 8),
          aad: Buffer.from("lost-browser-capture"),
          upload: {
            url: "https://storage.test/upload",
            requiredHeaders: { "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
        const captured = await supervisor.captureState(input);
        expect(captured.manifest.tabs).toEqual([{ url: fixture("Recovery"), selected: true }]);
        expect(await supervisor.captureState(input)).toEqual(captured);
        expect(uploads).toBe(1);
      }

      const recovered = await supervisor.listTargets(session);
      expect(driverLifecycles).toBe(operation === "capture" ? 3 : 2);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.id).not.toBe(created.observation.target.id);
      expect(recovered[0]!.url).toBe(fixture("Recovery"));

      const stale = await supervisor.action(clickCommand(created.observation));
      expect(stale.state).toBe("failed");
      expect(stale.error?.code).toBe("target_not_found");
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
);

function reference() {
  return {
    browserSessionId: randomUUID(),
    controllerGeneration: `controller-${randomUUID()}`,
  };
}

function fixture(label: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
    <html><head><title>${label}</title></head><body>
      <button onclick="this.textContent='${label} clicked'">${label}</button>
    </body></html>`)}`;
}

function clickCommand(observation: BrowserObservation): BrowserActionCommand {
  const button = flatten(
    observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
  ).find((node) => node.role === "button");
  if (!button) throw new Error("fixture button missing");
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    actor: { kind: "system", subjectId: "native-e2e" },
    action: { type: "click", locator: { kind: "ref", ref: button.ref } },
  };
}

function names(observation: BrowserObservation): string[] {
  return flatten(observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [])
    .map((node) => node.name)
    .filter((name): name is string => typeof name === "string");
}

function flatten(nodes: readonly InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function chromiumProfilePid(profileDirectory: string): Promise<number> {
  const lock = await readlink(join(profileDirectory, "SingletonLock"));
  const match = /-([1-9][0-9]{0,9})$/u.exec(lock);
  if (!match) throw new Error("Chromium profile lock did not contain an exact process id");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Chromium process id is invalid");
  return pid;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("Chromium did not exit after SIGKILL");
}

/** A killed process counts as dead once it is gone or a zombie its parent has
 * not reaped yet (Chrome does not reap its stderr drain). */
async function waitForProcessDeath(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const procStat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    if (procStat === null || procStat.slice(procStat.lastIndexOf(")") + 2).startsWith("Z")) return;
    await Bun.sleep(25);
  }
  throw new Error(`process ${pid} did not die after SIGKILL`);
}

async function parentPid(pid: number): Promise<number> {
  const procStat = await readFile(`/proc/${pid}/stat`, "utf8");
  return Number(procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[1]);
}

async function descendantPids(pid: number): Promise<number[]> {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => ""))
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number);
  const nested = await Promise.all(children.map((child) => descendantPids(child)));
  return [...children, ...nested.flat()];
}

/** The unified-hierarchy cgroup path of a process. */
async function processUnit(pid: number): Promise<string> {
  const line = (await readFile(`/proc/${pid}/cgroup`, "utf8"))
    .split("\n")
    .find((entry) => entry.startsWith("0::"));
  if (!line) throw new Error("process has no unified cgroup");
  return line.slice(3);
}

async function childPids(pid: number, command: string): Promise<number[]> {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number);
  const matches: number[] = [];
  for (const child of children) {
    const argv = await readFile(`/proc/${child}/cmdline`, "utf8").catch(() => "");
    if (basename(argv.split("\0")[0] ?? "") === command) matches.push(child);
  }
  return matches;
}

async function firstLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  let output = "";
  try {
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("controller exited before reporting its session");
      output += new TextDecoder().decode(chunk.value);
    }
    return output.slice(0, output.indexOf("\n"));
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
