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
  const click = (
    observation: BrowserObservation,
    name: string,
    type: "click" | "double_click" = "click",
    selector?: string,
  ) => {
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
      action: {
        type,
        locator: selector
          ? { kind: "css", selector }
          : { kind: "role", role: "button", name, exact: true },
      },
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

e2e(
  "a target the page re-renders as the pointer arrives still takes the click",
  async () => {
    // Moving the pointer onto "Confirm" re-renders it: the page swaps in an
    // identical copy, as a framework that re-renders on hover does.
    const fixture = await openFixture(
      '<!doctype html><title>Re-render</title><style>body{margin:0}</style><div id="row" style="padding:30px"><button id="target">Confirm</button></div><script>globalThis.clicks=0;let swapped=false;document.addEventListener("click",(event)=>{if(event.target.id==="target")clicks++});row.addEventListener("pointerover",()=>{if(swapped)return;swapped=true;row.innerHTML=row.innerHTML});</script>',
    );
    try {
      const accepted = await fixture.click(fixture.initial, "Confirm");
      expect(accepted.error ?? null).toBeNull();
      expect(accepted.state).toBe("completed");
      expect(await fixture.evaluate("[swapped, clicks]")).toEqual([true, 1]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

e2e(
  "a double-click whose first click turns its row into an editor still double-clicks",
  async () => {
    // The first click replaces the "Edit" button with a text field, as a
    // "double-click to edit" row does; the second press lands on the field.
    const fixture = await openFixture(
      '<!doctype html><title>Edit row</title><style>body{margin:0}input,button{width:120px;height:30px}</style><div id="row" style="padding:30px"><button id="target">Edit</button></div><script>globalThis.events=[];document.addEventListener("click",(event)=>{events.push("click:"+event.target.tagName);if(event.target.id==="target")row.innerHTML="<input id=editor>"});document.addEventListener("dblclick",(event)=>events.push("dblclick:"+event.target.tagName));</script>',
    );
    try {
      const accepted = await fixture.click(fixture.initial, "Edit", "double_click");
      expect(accepted.error ?? null).toBeNull();
      expect(accepted.state).toBe("completed");
      expect(await fixture.evaluate("events")).toEqual([
        "click:BUTTON",
        "click:INPUT",
        "dblclick:INPUT",
      ]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

e2e(
  "a lookalike that takes the target's place is not the target",
  async () => {
    // Three rows with identical "Delete" buttons. Row 1 is removed as the
    // pointer arrives, so row 2's button moves under the pointer.
    const rows = await openFixture(
      '<!doctype html><title>Rows</title><style>body{margin:0}.row{height:40px}</style><div id="list"><div class="row" id="r1"><button id="d1">Delete</button></div><div class="row" id="r2"><button id="d2">Delete</button></div><div class="row" id="r3"><button id="d3">Delete</button></div></div><script>globalThis.deleted=[];document.addEventListener("click",(event)=>{if(event.target.tagName==="BUTTON")deleted.push(event.target.id)});d1.addEventListener("pointerover",()=>r1.remove());</script>',
    );
    try {
      const refused = await rows.click(rows.initial, "Delete", "click", "#d1");
      expect(refused.state).not.toBe("completed");
      expect(await rows.evaluate("deleted")).toEqual([]);
    } finally {
      await rows.close();
    }
    // Hovering an unlabelled toolbar re-renders it with "Delete" where
    // "Archive" was.
    const toolbar = await openFixture(
      '<!doctype html><title>Toolbar</title><style>body{margin:0}button{width:120px;height:30px}</style><div role="toolbar" id="bar" style="padding:30px"><button id="archive">Archive</button></div><script>globalThis.clicked=[];document.addEventListener("click",(event)=>{if(event.target.tagName==="BUTTON")clicked.push(event.target.textContent)});bar.addEventListener("pointerover",()=>{if(bar.dataset.swapped)return;bar.dataset.swapped="1";bar.innerHTML="<button id=delete>Delete</button>"});</script>',
    );
    try {
      const refused = await toolbar.click(toolbar.initial, "Archive");
      expect(refused.state).not.toBe("completed");
      expect(await toolbar.evaluate("clicked")).toEqual([]);
    } finally {
      await toolbar.close();
    }
  },
  60_000,
);

// A page whose only content is a same-origin frame holding `content`; the
// frame logs to the page's `log`, which outlives the frame.
const framed = (content: string) =>
  `<!doctype html><title>Framed</title><style>body{margin:0}iframe{border:0;width:400px;height:200px}</style><script>globalThis.log=[];</script><iframe title="Panel" srcdoc="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;

e2e(
  "a press the guard held back stays refused when the page then removes the document",
  async () => {
    // Moving onto "Confirm" opens a cover over it, so the guard holds the
    // press back. The page's own earlier capture listener then removes the
    // frame on the release, before the guard can be read back.
    const fixture = await openFixture(
      framed(
        '<style>body{margin:0}#cover{display:none;position:fixed;inset:0;background:#fff}</style><div style="padding:30px"><button id="target">Confirm</button></div><div id="cover" role="dialog" aria-label="Cover"></div><script>target.addEventListener("click",()=>parent.log.push("confirm"));target.addEventListener("mouseenter",()=>{cover.style.display="block"});addEventListener("pointerup",()=>{parent.log.push("removed");frameElement.remove()},true);</script>',
      ),
    );
    try {
      const view = await fixture.driver.observe(fixture.initial.target.id);
      const refused = await fixture.click(view, "Confirm");
      expect(refused.state).not.toBe("completed");
      expect(refused.error?.message).toContain('covered by dialog "Cover"');
      expect(await fixture.evaluate("log")).toEqual(["removed"]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

e2e(
  "a press that reached the target counts when the click then removes the document",
  async () => {
    const fixture = await openFixture(
      framed(
        '<style>body{margin:0}</style><div style="padding:30px"><button id="target">Confirm</button></div><script>target.addEventListener("pointerdown",()=>parent.log.push("pressed"));addEventListener("pointerup",()=>{parent.log.push("removed");frameElement.remove()},true);</script>',
      ),
    );
    try {
      const view = await fixture.driver.observe(fixture.initial.target.id);
      const accepted = await fixture.click(view, "Confirm");
      expect(accepted.error ?? null).toBeNull();
      expect(accepted.state).toBe("completed");
      expect(await fixture.evaluate("log")).toEqual(["pressed", "removed"]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

e2e(
  "a click whose document disappears before the press reports an unknown outcome",
  async () => {
    // The pointer's arrival removes the frame holding "Confirm", so the press
    // lands on whatever is left; nothing confirms where it went.
    const fixture = await openFixture(
      framed(
        '<style>body{margin:0}</style><div style="padding:30px"><button id="target">Confirm</button></div><script>target.addEventListener("click",()=>parent.log.push("confirm"));target.addEventListener("mousemove",()=>{parent.log.push("removed");frameElement.remove()},{once:true});</script>',
      ),
    );
    try {
      const view = await fixture.driver.observe(fixture.initial.target.id);
      const result = await fixture.click(view, "Confirm");
      expect(result.state).toBe("outcome_unknown");
      expect(await fixture.evaluate("log")).toEqual(["removed"]);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);
