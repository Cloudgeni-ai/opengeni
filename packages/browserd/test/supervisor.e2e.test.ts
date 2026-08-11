import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { BrowserSupervisor } from "../src";

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
      supervisor.createSession({ ...first, headed: false, initialUrl: fixture("One") }),
      supervisor.createSession({ ...second, headed: false, initialUrl: fixture("Two") }),
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

function reference() {
  return { browserSessionId: randomUUID(), controllerGeneration: `controller-${randomUUID()}` };
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
