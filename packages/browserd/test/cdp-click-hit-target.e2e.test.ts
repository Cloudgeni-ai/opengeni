import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

async function openFixture(html: string) {
  const directory = await mkdtemp("/tmp/ogb-click-hit-target-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: false,
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
  const initial = await driver.start(`data:text/html,${encodeURIComponent(html)}`);
  const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
  const cdp = await CdpConnection.connect(endpoint.cdpUrl);
  const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: initial.target.id,
    flatten: true,
  });
  const evaluate = async (expression: string) =>
    (
      await cdp.send<{ result: { value: unknown } }>(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        { sessionId: attached.sessionId },
      )
    ).result.value;
  const click = (observation: BrowserObservation, name: string) => {
    const command: BrowserActionCommand = {
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "click-hit-target-fixture" },
      observationMode: "none",
      action: { type: "click", locator: { kind: "role", role: "button", name, exact: true } },
    };
    return controller.run(command);
  };
  const close = async () => {
    await cdp.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { initial, driver, evaluate, click, close };
}

e2e(
  "a click never lands on a popover that follows its anchor back over the target",
  async () => {
    // A scrolling side panel with a row button. An open picker is a fixed
    // layer anchored to the "Assign" button below that row, so its last
    // option sits over "Confirm", and it follows its anchor on every scroll,
    // the way floating-UI popovers do. Scrolling the panel only uncovers
    // "Confirm" until the next frame repositions the picker.
    const fixture = await openFixture(
      '<!doctype html><title>Anchored popover</title><style>body{margin:0}#panel{position:absolute;top:0;left:0;width:400px;height:300px;overflow-y:auto}.row{height:40px;display:flex;align-items:center;gap:8px}#pop{position:fixed;left:0;width:300px;height:40px;background:#fff;z-index:5}#grace{height:40px}</style><div id="panel"><div style="height:200px">Details</div><div class="row"><span>Ada</span><button id="target">Confirm</button></div><button id="assign">Assign</button><div style="height:600px"></div></div><div id="pop" role="listbox" aria-label="Suggestions"><div role="option" id="grace">Grace</div></div><script>globalThis.clicks={confirm:0,grace:0};target.addEventListener("click",()=>clicks.confirm++);grace.addEventListener("click",()=>clicks.grace++);const place=()=>{pop.style.top=(assign.getBoundingClientRect().top-40)+"px"};place();panel.addEventListener("scroll",place);</script>',
    );
    try {
      // Precondition: the picker's option covers "Confirm" at its centre.
      expect(
        await fixture.evaluate(
          "(() => { const r = target.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).id; })()",
        ),
      ).toBe("grace");

      const refused = await fixture.click(fixture.initial, "Confirm");
      expect(refused.state).not.toBe("completed");
      expect(refused.error?.message).toContain("covered");
      // Neither the named button nor the option under it was clicked.
      expect(await fixture.evaluate("[clicks.confirm, clicks.grace]")).toEqual([0, 0]);

      // With the picker closed the same click lands on "Confirm" once.
      await fixture.evaluate('pop.remove(); panel.scrollTop = 0; "ok"');
      const view = await fixture.driver.observe(fixture.initial.target.id);
      const accepted = await fixture.click(view, "Confirm");
      expect(accepted.error ?? null).toBeNull();
      expect(accepted.state).toBe("completed");
      expect(await fixture.evaluate("[clicks.confirm, clicks.grace]")).toEqual([1, 0]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

e2e(
  "a layer that appears over the target as the pointer arrives receives no click",
  async () => {
    // Nothing covers "Confirm" when it is hit-tested, but moving the pointer
    // onto it opens a hover card over it. The press would land on the card.
    const fixture = await openFixture(
      '<!doctype html><title>Hover card</title><style>body{margin:0}#card{display:none;position:absolute;top:0;left:0;width:300px;height:100px;background:#fff}</style><div style="padding:30px"><button id="target">Confirm</button></div><div id="card" role="dialog" aria-label="Profile card"><button id="follow">Follow</button></div><script>globalThis.clicks={confirm:0,card:0};target.addEventListener("click",()=>clicks.confirm++);card.addEventListener("click",()=>clicks.card++);target.addEventListener("mouseenter",()=>{card.style.display="block"});</script>',
    );
    try {
      const refused = await fixture.click(fixture.initial, "Confirm");
      expect(refused.state).not.toBe("completed");
      expect(refused.error?.message).toContain('covered by dialog "Profile card"');
      expect(await fixture.evaluate("[clicks.confirm, clicks.card]")).toEqual([0, 0]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);
