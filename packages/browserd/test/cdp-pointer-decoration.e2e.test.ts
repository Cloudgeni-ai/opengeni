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
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";

/**
 * Comboboxes whose "browse options" chevron is drawn over the field but takes
 * no pointer input (pointer-events: none), so a person's click on it reaches
 * the combobox: the field lies beneath it, or the field's frame takes the
 * click and opens its field. The page logs every click and pointer move it
 * sees.
 */
const STYLE =
  ".field{position:relative;width:260px;margin:8px}.field input{width:100%;box-sizing:border-box;padding:6px 32px 6px 6px}.chevron{position:absolute;right:2px;top:2px;bottom:2px;width:28px;pointer-events:none;border:0;background:#ddd}.frame{display:flex;position:relative;width:260px;margin:8px;padding:4px;border:1px solid #888}.frame input{width:200px;border:0}.picker{display:block;position:relative;width:260px;height:32px;margin:8px;border:1px solid #888}";
const FIXTURE = `<!doctype html><title>Pick</title><style>${STYLE}</style><main>
<label for="country">Country</label><div class="field"><input id="country" role="combobox" aria-expanded="false" aria-autocomplete="list"><button class="chevron" tabindex="-1" aria-label="browse options">v</button></div>
<label for="city">City</label><div class="frame"><input id="city" role="combobox" aria-expanded="false"><span class="chevron" role="button" aria-label="browse cities">v</span></div>
<label for="region">Region</label><div class="field"><input id="region" role="combobox" aria-expanded="false"><button class="chevron" tabindex="-1" aria-label="browse regions" aria-disabled="true">v</button></div>
<div class="picker"><button style="pointer-events:none" aria-label="browse nothing">v</button></div>
</main><script>
globalThis.log=[];
document.addEventListener("pointermove",()=>{if(log.at(-1)!=="move")log.push("move")},true);
for(const box of document.querySelectorAll("[role=combobox]"))box.addEventListener("click",(event)=>{event.stopPropagation();box.setAttribute("aria-expanded","true");log.push("open "+box.id)});
const frame=document.querySelector(".frame");frame.addEventListener("click",()=>{const city=document.getElementById("city");city.focus();city.setAttribute("aria-expanded","true");log.push("open city from its frame")});
for(const button of document.querySelectorAll("button"))button.addEventListener("click",()=>log.push("button "+button.getAttribute("aria-label")));
</script>`;

function nodes(observation: BrowserObservation | null | undefined): InteractionSemanticNodeValue[] {
  const semantic = observation?.semantic;
  const pending: InteractionSemanticNodeValue[] =
    semantic?.kind === "snapshot" ? [...semantic.roots] : [];
  const found: InteractionSemanticNodeValue[] = [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    found.push(node);
    if (node.children) pending.unshift(...node.children);
  }
  return found;
}

e2e(
  "a chevron that takes no pointer input is left out of the outline and a press on it reaches its combobox",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-pointer-decoration-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed,
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
    let cdp: CdpConnection | null = null;
    try {
      const initial = await driver.start(`data:text/html,${encodeURIComponent(FIXTURE)}`);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const evaluate = async (expression: string) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      const act = (action: BrowserActionCommand["action"]) =>
        controller.run({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: initial.target.id,
          expectedTargetGeneration: initial.target.targetGeneration,
          expectedDocumentGeneration: initial.target.documentGeneration!,
          expectedFrameId: initial.frameId!,
          actor: { kind: "human", subjectId: "pointer-decoration-fixture" },
          observationMode: "none",
          action,
        });
      const press = (name: string) =>
        act({ type: "click", locator: { kind: "role", role: "button", name, exact: true } });

      // The outline offers the comboboxes, not the chevrons drawn on them.
      const outline = nodes(await driver.observe(initial.target.id));
      const named = (name: string) => outline.filter((node) => node.name === name);
      expect(named("browse options")).toEqual([]);
      expect(named("browse cities")).toEqual([]);
      expect(named("Country").some((node) => node.role === "combobox")).toBe(true);
      expect(named("City").some((node) => node.role === "combobox")).toBe(true);
      // A disabled chevron, and one over nothing that takes the click, stay.
      expect(named("browse regions").length).toBe(1);
      expect(named("browse nothing").length).toBe(1);

      // Pressing a chevron reaches the combobox under it, as a person's
      // click there does, whether the field lies beneath it or holds it.
      const country = await press("browse options");
      expect(country.error ?? null).toBeNull();
      expect(country.state).toBe("completed");
      const city = await press("browse cities");
      expect(city.error ?? null).toBeNull();
      expect(city.state).toBe("completed");
      expect((await evaluate("log")) as string[]).toEqual([
        "move",
        "open country",
        "move",
        "open city from its frame",
      ]);

      // Typing into the combobox still works.
      const typed = await act({
        type: "fill",
        locator: { kind: "role", role: "combobox", name: "Country", exact: true },
        value: "Nor",
      });
      expect(typed.state).toBe("completed");
      expect(await evaluate('document.getElementById("country").value')).toBe("Nor");

      // A chevron over nothing that takes the click is refused before any
      // input reaches the page, so the refusal is definite.
      await evaluate("log.length = 0");
      const nothing = await press("browse nothing");
      expect(nothing.state).toBe("failed");
      expect(nothing.error?.code).toBe("invalid_action");
      expect(nothing.error?.message).toBe(
        "browser element does not take pointer input (pointer-events: none), which often means it is disabled; use another control",
      );
      expect(await evaluate("log")).toEqual([]);

      // A disabled chevron over an enabled field is refused, not pressed
      // through to the field (after the wait an input action gives a
      // disabled element).
      const region = await press("browse regions");
      expect(region.state).toBe("failed");
      expect(region.error?.code).toBe("invalid_action");
      expect(await evaluate("log")).toEqual([]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
