import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { AgentBrowserDriver, AgentBrowserJsonRunner, BrowserSupervisor } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e("runs multiple real browser sessions through one placement supervisor", async () => {
  const directory = await mkdtemp("/tmp/ogb-supervisor-e2e-");
  const socketDirectory = await mkdtemp("/tmp/ogs-");
  const supervisor = await BrowserSupervisor.open({
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

e2e("recovers after exact Chromium process loss without reusing target refs", async () => {
  const directory = await mkdtemp("/tmp/ogb-browser-loss-e2e-");
  const socketDirectory = await mkdtemp("/tmp/ogl-");
  let driverLifecycles = 0;
  let profileDirectory: string | undefined;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: socketDirectory,
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

    const recovered = await supervisor.listTargets(session);
    expect(driverLifecycles).toBe(2);
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
});

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
