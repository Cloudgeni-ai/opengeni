import { randomUUID } from "node:crypto";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  AgentBrowserDriver,
  ManagedBrowserRunner,
  BrowserSupervisor,
  type BrowserSupervisorSessionOptions,
  managedChromiumLaunchExecutable,
} from "../../src";

/** One managed Chromium controller as the native agent runs it. A recovery test
 * runs its first controller in a child process (this file as main) so it can be
 * killed outright, as a service stop does, and recovers in a second one. */
export async function openManagedRecoverySupervisor(
  rootDirectory: string,
  settings: { idleReleaseMs?: number; now?: () => number } = {},
): Promise<BrowserSupervisor> {
  return await BrowserSupervisor.open({
    rootDirectory,
    ...settings,
    createDriver: async (context) => {
      // Launch exactly what the production driver launches, including after
      // recovery, while applying the same container launch flags as the
      // other Chromium CI fixtures.
      const { browserExecutablePath } = await managedChromiumLaunchExecutable(context);
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: context.profileDirectory,
        headed: context.headed,
        ...(browserExecutablePath ? { browserExecutablePath } : {}),
        launchArguments: ["--no-sandbox", "--disable-gpu"],
        ...(context.recoverOwnedProcess
          ? {
              recoverOwnedProcess: context.recoverOwnedProcess,
              allowOwnedProcessLaunch: context.allowOwnedProcessLaunch,
            }
          : {}),
      });
      return new AgentBrowserDriver({
        browserSessionId: context.browserSessionId,
        controllerGeneration: context.controllerGeneration,
        runner,
        focusEmulation: true,
        downloadDirectory: context.downloadDirectory,
        ...(context.downloadEvents ? { downloadEvents: context.downloadEvents } : {}),
        resolveWorkspaceFiles: context.resolveWorkspaceFiles,
      });
    },
  });
}

export function clickFirstButton(observation: BrowserObservation): BrowserActionCommand {
  const button = flatten(
    observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
  ).find((node) => node.role === "button");
  if (!button?.ref) throw new Error("fixture button missing");
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

export function semanticNames(observation: BrowserObservation): string[] {
  return flatten(observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [])
    .map((node) => node.name)
    .filter((name): name is string => typeof name === "string");
}

function flatten(nodes: readonly InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

if (import.meta.main) {
  const input = JSON.parse(process.argv[2]!) as {
    rootDirectory: string;
    options: BrowserSupervisorSessionOptions;
  };
  const supervisor = await openManagedRecoverySupervisor(
    input.rootDirectory,
  );
  const created = await supervisor.createSession(input.options);
  const clicked = await supervisor.action(clickFirstButton(created.observation));
  console.log(JSON.stringify({ state: clicked.state, names: semanticNames(clicked.observation!) }));
  // Hold the controller until the test kills this process.
  setInterval(() => {}, 60_000);
}
