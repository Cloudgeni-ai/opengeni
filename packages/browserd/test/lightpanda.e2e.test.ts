import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import {
  AgentBrowserDriver,
  BrowserSupervisor,
  LightpandaRunner,
  resolvePinnedLightpandaBinary,
  type BrowserSupervisorDriver,
} from "../src";

const binaryPath = process.env.OPENGENI_BROWSERD_LIGHTPANDA_BINARY;
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" && binaryPath ? test : test.skip;

e2e("runs Lightpanda as an exact capability-scoped managed browser", async () => {
  const directory = await mkdtemp("/tmp/ogb-lightpanda-");
  const socketDirectory = `/tmp/lps-${randomUUID().slice(0, 8)}`;
  const binary = await resolvePinnedLightpandaBinary({ binaryPath: binaryPath! });
  const page = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      return html(
        url.pathname === "/next"
          ? "<!doctype html><title>Next page</title><h1>Next page</h1>"
          : "<!doctype html><title>Lightpanda fixture</title><h1>Lightpanda fixture</h1>",
      );
    },
  });
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: socketDirectory,
    lightpandaBinary: binary,
  });
  const reference = {
    browserSessionId: randomUUID(),
    controllerGeneration: "lightpanda-controller-1",
  };
  try {
    const created = await supervisor.createSession({
      ...reference,
      headed: false,
      initialUrl: `http://127.0.0.1:${page.port}`,
      transport: { kind: "managed", engine: "lightpanda" },
    });
    expect(semanticNames(created.observation)).toContain("Lightpanda fixture");
    expect((await supervisor.screenshot(reference, created.observation.target.id)).mediaType).toBe(
      "image/png",
    );

    const receipt = await supervisor.action(
      navigateCommand(created.observation, `http://127.0.0.1:${page.port}/next`),
    );
    expect(receipt.state).toBe("completed");
    expect(semanticNames(receipt.observation!)).toContain("Next page");
    await expect(supervisor.openTarget(reference)).rejects.toThrow(
      "does not support multiple tabs",
    );
    await expect(
      supervisor.subscribeFrames(reference, created.observation.target.id),
    ).rejects.toThrow("does not support live frame streaming");
    await expect(supervisor.listDownloads(reference)).rejects.toThrow(
      "does not expose managed downloads",
    );
  } finally {
    page.stop(true);
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  }
});

e2e("recovers a lost Lightpanda process without replaying mutations", async () => {
  const directory = await mkdtemp("/tmp/ogb-lightpanda-recovery-");
  const socketDirectory = `/tmp/lpr-${randomUUID().slice(0, 8)}`;
  const binary = await resolvePinnedLightpandaBinary({ binaryPath: binaryPath! });
  const page = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => html("<!doctype html><title>Recovery page</title><h1>Recovery page</h1>"),
  });
  let activeRunner: LightpandaRunner | null = null;
  let driverCreations = 0;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: socketDirectory,
    createDriver: async (context): Promise<BrowserSupervisorDriver> => {
      driverCreations += 1;
      const runner = await LightpandaRunner.create({
        binary,
        sessionDirectory: join(context.sessionDirectory, `lightpanda-${driverCreations}`),
      });
      activeRunner = runner;
      return new AgentBrowserDriver({
        browserSessionId: context.browserSessionId,
        controllerGeneration: context.controllerGeneration,
        runner,
        engine: "lightpanda",
        targetLifecycle: "cdp",
        tabControl: false,
        frameStreaming: false,
        permissionControl: false,
        resolveWorkspaceFiles: context.resolveWorkspaceFiles,
      });
    },
  });
  const reference = {
    browserSessionId: randomUUID(),
    controllerGeneration: "lightpanda-recovery-1",
  };
  try {
    const created = await supervisor.createSession({
      ...reference,
      headed: false,
      initialUrl: `http://127.0.0.1:${page.port}`,
      transport: { kind: "managed", engine: "lightpanda" },
    });
    const oldTargetId = created.observation.target.id;
    await activeRunner!.terminate();

    const targets = await supervisor.listTargets(reference);
    expect(driverCreations).toBe(2);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(oldTargetId);
    expect(targets[0]!.targetGeneration).not.toBe(created.observation.target.targetGeneration);
    expect(semanticNames(await supervisor.observe(reference, targets[0]!.id))).toContain(
      "Recovery page",
    );
  } finally {
    page.stop(true);
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  }
});

function navigateCommand(observation: BrowserObservation, url: string): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration!,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "lightpanda-conformance" },
    action: { type: "navigate", url },
  };
}

function semanticNames(observation: BrowserObservation): string[] {
  if (observation.semantic?.kind !== "snapshot") return [];
  const names: string[] = [];
  const pending = [...observation.semantic.roots];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.name) names.push(node.name);
    if (node.children) pending.push(...node.children);
  }
  return names;
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
