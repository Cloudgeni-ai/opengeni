import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

function hasRole(observation: BrowserObservation | null | undefined, role: string): boolean {
  const semantic = observation?.semantic;
  const pending: InteractionSemanticNodeValue[] =
    semantic?.kind === "snapshot" ? [...semantic.roots] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.role === role) return true;
    if (node.children) pending.push(...node.children);
  }
  return false;
}

e2e(
  "the post-action observation waits for a closing overlay to finish animating out",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-exit-animation-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `exit_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({ browserSessionId, controllerGeneration, runner });
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    // "Choose" closes the listbox the way component libraries do: it starts
    // an exit animation and removes the element when the animation ends. The
    // spinner never finishes, and "Slow" starts an animation far longer than
    // any settle bound; neither may hold the observation back indefinitely.
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Exit proof</title><style>@keyframes out{to{opacity:0}}@keyframes spin{to{transform:rotate(360deg)}}.closing{animation:out 400ms linear forwards}.slow{animation:out 30s linear forwards}#spinner{width:8px;height:8px;animation:spin 1s linear infinite}</style><div id="spinner"></div><button>Choose</button><button>Slow</button><div id="menu" role="listbox" aria-label="Choices"><div role="option" aria-selected="false">Only choice</div></div><div id="panel" role="dialog" aria-label="Panel">Panel</div><script>const close=(id,name)=>{const element=document.getElementById(id);element.classList.add(name);element.addEventListener("animationend",()=>element.remove(),{once:true})};document.querySelectorAll("button")[0].addEventListener("click",()=>close("menu","closing"));document.querySelectorAll("button")[1].addEventListener("click",()=>close("panel","slow"));</script>',
    )}`;
    const command = (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "exit-animation-fixture" },
      observationMode: "full",
      action,
    });
    try {
      const initial = await driver.start(fixture);
      expect(hasRole(initial, "listbox")).toBe(true);

      const chosen = await controller.run(
        command(initial, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Choose", exact: true },
        }),
      );
      expect(chosen.state).toBe("completed");
      // The listbox was dismissed by the click; the result must not show it
      // as still open merely because it was fading out.
      expect(hasRole(chosen.observation, "listbox")).toBe(false);
      expect(hasRole(chosen.observation, "dialog")).toBe(true);

      // A very long finite animation is waited for only up to a short bound.
      const startedAt = Date.now();
      const slow = await controller.run(
        command(chosen.observation!, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Slow", exact: true },
        }),
      );
      expect(slow.state).toBe("completed");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(hasRole(slow.observation, "dialog")).toBe(true);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
