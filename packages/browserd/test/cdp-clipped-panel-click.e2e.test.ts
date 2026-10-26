import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";

const LONG = "Quarterly handoff reference for the printable export of the east wing project";

const fixture = (lines: string[]) => `data:text/html,${encodeURIComponent(lines.join(""))}`;

// A split view: a folder tree in a fixed-width side panel that clips its
// rows, and the file list beside it. Long rows run past the panel's edge, so
// their centers lie over the file list, which the panel's clip leaves on top
// there. Every row still shows its start, which is where a person clicks.
const FIXTURE = fixture([
  "<!doctype html><title>Folders</title>",
  "<style>",
  "body{margin:0;font:14px sans-serif}",
  "#split{display:flex;height:100vh}",
  "#side{flex:0 0 260px;overflow:hidden}",
  "#scroller{height:100%;overflow-x:hidden;overflow-y:auto}",
  "[role=treeitem]{display:flex;width:max-content;min-width:100%;white-space:nowrap;line-height:28px;cursor:pointer}",
  "#files{flex:1;background:#f4f4f4}",
  "#menu{position:fixed;left:0;top:0;width:280px;height:100vh;background:#fff}",
  "</style>",
  // Above the tree, a pinned row in a strip that clips without scrolling,
  // indented wholly past the panel's edge.
  '<div id="split"><div id="side"><div style="overflow:clip"><div role="treeitem" id="pinned" aria-level="1" tabindex="-1" style="padding-left:300px"><span>Past the edge</span></div></div>',
  '<div id="scroller"><div role="tree" aria-label="Folders">',
  '<div role="treeitem" id="exports" aria-level="1" aria-expanded="false" tabindex="0" style="padding-left:8px"><span><span>Exports</span></span></div>',
  '<div role="group" id="children" hidden>',
  `<div role="treeitem" id="year" aria-level="2" tabindex="-1" style="padding-left:24px"><span><span>2026 ${LONG}</span></span></div>`,
  "</div>",
  `<div role="treeitem" id="handoff" aria-level="1" tabindex="-1" style="padding-left:8px"><span><span>${LONG}</span></span></div>`,
  "</div></div></div>",
  '<div role="group" aria-label="Files" id="files"><nav><button>Files</button></nav></div></div>',
  "<script>",
  "globalThis.log=[];",
  'document.getElementById("files").addEventListener("click",()=>log.push("FILES"));',
  'for (const row of document.querySelectorAll("[role=treeitem]")) row.addEventListener("click",(event)=>{event.stopPropagation();log.push(row.id)});',
  'document.getElementById("exports").addEventListener("click",()=>{const children=document.getElementById("children");children.hidden=!children.hidden;document.getElementById("exports").setAttribute("aria-expanded",String(!children.hidden))});',
  "</script>",
]);

interface Session {
  evaluate: (expression: string) => Promise<unknown>;
  click: (
    action: BrowserActionCommand["action"],
  ) => ReturnType<BrowserInteractionController["run"]>;
}

const treeitem = (name: string) => ({ kind: "role", role: "treeitem", name, exact: true }) as const;

async function withSession(page: string, body: (session: Session) => Promise<void>) {
  const directory = await mkdtemp("/tmp/ogb-clipped-panel-click-");
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
    actor: { kind: "human", subjectId: "clipped-panel-click-fixture" },
    observationMode: "none",
    action,
  });
  try {
    const initial = await driver.start(page);
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
          { expression, returnByValue: true, awaitPromise: true },
          { sessionId: attached.sessionId },
        )
      ).result.value;
    const click = async (action: BrowserActionCommand["action"]) =>
      await controller.run(command(await driver.observe(initial.target.id), action));
    await body({ evaluate, click });
  } finally {
    await cdp?.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "a tree row that runs past its panel's clipped edge is clicked where it shows; a real cover still refuses",
  async () => {
    await withSession(FIXTURE, async ({ evaluate, click }) => {
      // The row's center is over the file list, but its start shows in the
      // panel. Both the row and its label text take the click there.
      expect(
        await evaluate(
          'const r = document.getElementById("handoff").getBoundingClientRect(); r.left + r.width / 2 > 260',
        ),
      ).toBe(true);
      const row = await click({ type: "click", locator: treeitem(LONG) });
      expect(row.error ?? null).toBeNull();
      expect(row.state).toBe("completed");
      const text = await click({
        type: "click",
        locator: { kind: "text", text: LONG, exact: true },
      });
      expect(text.error ?? null).toBeNull();
      expect(text.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["handoff", "handoff"]);

      // A freshly expanded child, indented further, works the same way.
      const expand = await click({ type: "click", locator: treeitem("Exports") });
      expect(expand.state).toBe("completed");
      const child = await click({ type: "click", locator: treeitem(`2026 ${LONG}`) });
      expect(child.error ?? null).toBeNull();
      expect(child.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["handoff", "handoff", "exports", "year"]);

      // Wholly past the panel's edge: nothing of it shows, so it is refused
      // with the reason, and the file list beside it is not clicked.
      const past = await click({
        type: "click",
        locator: { kind: "text", text: "Past the edge", exact: true },
      });
      expect(past.state).toBe("failed");
      expect(past.error?.message).toBe(
        "browser element is out of view: it lies past the clipped edge of a panel or container that holds it; scroll that panel to it, or use another control",
      );

      // A menu over the panel covers the part of the row that shows: that is
      // a real cover, so the click is refused, naming the menu.
      await evaluate(
        'document.body.insertAdjacentHTML("beforeend", \'<div id="menu" role="menu" aria-label="Folder actions"></div>\')',
      );
      const covered = await click({ type: "click", locator: treeitem(LONG) });
      // Scrolling the row back into view moved the tree, so the refusal is an
      // unknown outcome that carries the reason.
      expect(covered.state).toBe("outcome_unknown");
      expect(covered.error?.message).toContain(
        '(invalid_action: browser element is covered by menu "Folder actions" where it shows)',
      );
      expect(await evaluate("log")).toEqual(["handoff", "handoff", "exports", "year"]);
    });
  },
  60_000,
);

// A row cut off at its side panel's edge, with a narrow menu over the middle
// of the part that shows. In the content group beside the panel, a header
// that transforms and clips its overflow holds an open popover menu: the
// popover is in the top layer, so the header does not clip it, and a toast
// opened later in the top layer covers its item.
const COVERS = fixture([
  "<!doctype html><title>Covers</title>",
  "<style>",
  "body{margin:0;font:14px sans-serif}",
  "#split{display:flex;height:100vh}",
  "#side{flex:0 0 260px;overflow:hidden}",
  "[role=treeitem]{display:flex;width:max-content;min-width:100%;white-space:nowrap;line-height:28px;padding-left:8px}",
  "#files{flex:1;background:#f4f4f4}",
  "#popup{position:fixed;left:100px;top:0;width:60px;height:200px;background:#fff}",
  "header{transform:translateX(0);overflow:hidden;height:40px;background:#ddd}",
  "[popover]{position:fixed;inset:auto;margin:0;border:0;padding:0;background:#fff}",
  "#actions{left:400px;top:200px;width:200px;height:120px}",
  "#rename{display:block;height:120px}",
  "#toast{left:450px;top:240px;width:100px;height:40px}",
  "</style>",
  '<div id="split"><div id="side"><div role="tree" aria-label="Folders">',
  `<div role="treeitem" id="handoff" aria-level="1" tabindex="-1"><span>${LONG} ${LONG}</span></div>`,
  "</div></div>",
  '<div role="group" aria-label="Files" id="files"><header><div popover="manual" id="actions" role="menu" aria-label="Actions"><div role="menuitem" id="rename" tabindex="-1">Rename</div></div></header></div></div>',
  '<div id="popup" role="menu" aria-label="Popup"></div>',
  '<div popover="manual" id="toast" role="status" aria-label="Saved">Saved</div>',
  "<script>",
  "globalThis.log=[];",
  'document.getElementById("files").addEventListener("click",()=>log.push("FILES"));',
  'document.getElementById("popup").addEventListener("click",()=>log.push("POPUP"));',
  'for (const id of ["handoff","rename"]) document.getElementById(id).addEventListener("click",(event)=>{event.stopPropagation();log.push(id);globalThis.at=event.clientX});',
  'document.getElementById("actions").showPopover();',
  "</script>",
]);

e2e(
  "a cover over the middle of where a cut-off row shows refuses; a covered top-layer item is covered, not cut off",
  async () => {
    await withSession(COVERS, async ({ evaluate, click }) => {
      const row = treeitem(`${LONG} ${LONG}`);
      expect(
        await evaluate(
          'const r = document.getElementById("handoff").getBoundingClientRect(); r.left + r.width / 2 > 260',
        ),
      ).toBe(true);

      // The menu sits over the middle of the part of the row that shows: a
      // real cover there, even though the row shows on either side of it.
      const covered = await click({ type: "click", locator: row });
      expect(covered.state).not.toBe("completed");
      expect(covered.error?.message).toContain(
        'browser element is covered by menu "Popup" where it shows',
      );
      expect(await evaluate("log")).toEqual([]);

      // Moved off that middle, the menu still covers part of what shows, but
      // the row takes the click at the middle.
      await evaluate('document.getElementById("popup").style.left = "200px"');
      const clicked = await click({ type: "click", locator: row });
      expect(clicked.error ?? null).toBeNull();
      expect(clicked.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["handoff"]);
      // Pressed at the middle of the part that shows, the panel's 260px.
      expect(Math.abs(Number(await evaluate("at")) - 130)).toBeLessThanOrEqual(3);

      // The popover's item lies outside the clipping header, which does not
      // clip the top layer: it takes the click.
      const item = { kind: "role", role: "menuitem", name: "Rename", exact: true } as const;
      const renamed = await click({ type: "click", locator: item });
      expect(renamed.error ?? null).toBeNull();
      expect(renamed.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["handoff", "rename"]);

      // A toast opened over it covers it at its center: that is the refusal,
      // not a cut-off one that would send the agent scrolling a panel.
      await evaluate('document.getElementById("toast").showPopover()');
      const toasted = await click({ type: "click", locator: item });
      expect(toasted.state).not.toBe("completed");
      expect(toasted.error?.message).toContain(
        'browser element is covered by status "Saved" at its center',
      );

      // A long label of characters outside the BMP is cut on a character
      // boundary, within 160 bytes of UTF-8, and its quote still closes.
      await evaluate(
        'document.getElementById("toast").setAttribute("aria-label", "\\u{1F5C2}".repeat(100))',
      );
      const long = await click({ type: "click", locator: item });
      expect(long.state).not.toBe("completed");
      const named = /browser element is covered by (.*) at its center/.exec(
        long.error?.message ?? "",
      );
      expect(named).not.toBeNull();
      const cover = named![1]!;
      expect(cover).toStartWith('status "\u{1F5C2}');
      expect(cover).toEndWith('…"');
      // No half of a surrogate pair: it would not survive UTF-8 unchanged.
      expect(Buffer.from(cover, "utf8").toString("utf8")).toBe(cover);
      expect(Buffer.byteLength(cover, "utf8")).toBeLessThanOrEqual(160);
      expect(JSON.parse(cover.slice("status ".length))).toEndWith("…");
      expect(await evaluate("log")).toEqual(["handoff", "rename"]);
    });
  },
  60_000,
);

const SPLIT_STYLE = [
  ".split{display:flex;height:100px;width:900px}",
  ".side{flex:0 0 260px;overflow:hidden}",
  "[role=treeitem]{display:flex;width:max-content;min-width:100%;white-space:nowrap;line-height:28px;padding-left:8px}",
  ".files{flex:1;background:#f4f4f4}",
].join("");
const split = (id: string, label: string) =>
  `<div class="split"><div class="side"><div role="tree" aria-label="${label} folders"><div role="treeitem" id="${id}" aria-level="1" tabindex="-1"><span>${label} ${LONG}</span></div></div></div><div role="group" aria-label="${label} files" class="files"></div></div>`;
const LISTENERS =
  'for (const row of document.querySelectorAll("[role=treeitem]")) row.addEventListener("click",(event)=>{event.stopPropagation();top.log.push(row.id)});for (const files of document.querySelectorAll(".files")) files.addEventListener("click",()=>top.log.push("FILES"));';
const srcdoc = (html: string) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

// The same cut-off row in a panel scaled by a transform, in one magnified by
// CSS zoom, and in a same-origin frame.
const TRANSFORMED = fixture([
  "<!doctype html><title>Panels</title>",
  `<style>body{margin:0;font:14px sans-serif}${SPLIT_STYLE}</style>`,
  `<div style="transform:scale(0.8);transform-origin:0 0;height:100px">${split("scaled", "Scaled")}</div>`,
  `<div style="zoom:1.5">${split("zoomed", "Zoomed")}</div>`,
  `<iframe title="Panel" style="display:block;width:900px;height:120px;border:0" srcdoc="${srcdoc(
    `<!doctype html><style>body{margin:0;font:14px sans-serif}${SPLIT_STYLE}</style>${split("framed", "Framed")}<script>${LISTENERS}</script>`,
  )}"></iframe>`,
  `<script>globalThis.log=[];${LISTENERS}</script>`,
]);

e2e(
  "a cut-off row in a scaled, zoomed or framed panel is clicked where it shows",
  async () => {
    await withSession(TRANSFORMED, async ({ evaluate, click }) => {
      expect(
        await evaluate(
          'new Promise((resolve) => { const check = () => document.querySelector("iframe").contentDocument?.getElementById("framed") ? resolve(true) : setTimeout(check, 20); check(); })',
        ),
      ).toBe(true);
      // Every row's center lies past its panel's edge, over its file list.
      expect(
        await evaluate(
          '[document, document.querySelector("iframe").contentDocument].flatMap((page) => [...page.querySelectorAll("[role=treeitem]")].map((row) => { const r = row.getBoundingClientRect(); const side = row.closest(".side").getBoundingClientRect(); return r.left + r.width / 2 > side.right; }))',
        ),
      ).toEqual([true, true, true]);
      for (const label of ["Scaled", "Zoomed", "Framed"]) {
        const result = await click({ type: "click", locator: treeitem(`${label} ${LONG}`) });
        expect(result.error ?? null).toBeNull();
        expect(result.state).toBe("completed");
      }
      expect(await evaluate("log")).toEqual(["scaled", "zoomed", "framed"]);
    });
  },
  60_000,
);

// A button the page shuts out of pointer input from outside it: behind a
// native modal dialog, inside an inert page under an overlay, and under a
// modal library's pointer-events: none on the body with its overlay. The
// browser's hit stack leaves the button out in each, as it does a cut-off
// row, but here what is on top really is over it.
const SHUT_OUT = fixture([
  "<!doctype html><title>Modals</title>",
  "<style>",
  "body{margin:0;font:14px sans-serif}",
  "#behind{position:absolute;left:40px;top:40px;width:160px;height:40px}",
  "#settings{width:300px;height:120px;margin:0;left:400px;top:300px}",
  ".veil{position:fixed;inset:0;background:rgba(0,0,0,.3);pointer-events:auto}",
  "</style>",
  '<main id="page"><button id="behind">Behind</button></main>',
  '<dialog id="settings" aria-label="Settings"><button id="close">Close</button></dialog>',
  "<script>",
  "globalThis.log=[];",
  'document.getElementById("behind").addEventListener("click",()=>log.push("behind"));',
  "</script>",
]);

e2e(
  "a target shut out behind a modal, an inert page or a body without pointer input is covered at its center",
  async () => {
    await withSession(SHUT_OUT, async ({ evaluate, click }) => {
      // Behind is found by CSS, as from an observation made before the
      // modal opened; role locators already skip inert content.
      const behind = { type: "click", locator: { kind: "css", selector: "#behind" } } as const;
      const refusal = async (cover: string) => {
        const result = await click(behind);
        expect(result.state).not.toBe("completed");
        expect(result.error?.message).toContain(
          `browser element is covered by ${cover} at its center`,
        );
        expect(await evaluate("log")).toEqual([]);
      };

      // A native modal dialog makes the rest of the page inert.
      await evaluate('document.getElementById("settings").showModal()');
      await refusal('dialog "Settings"');
      await evaluate('document.getElementById("settings").close()');

      // An inert page under an overlay.
      await evaluate(
        'document.getElementById("page").inert = true; document.body.insertAdjacentHTML("beforeend", \'<div class="veil" id="veil">Hi</div>\')',
      );
      await refusal('div "Hi"');
      await evaluate(
        'document.getElementById("page").inert = false; document.getElementById("veil").remove()',
      );

      // A modal library's pointer-events: none on the body, with its overlay.
      await evaluate(
        'document.body.style.pointerEvents = "none"; document.body.insertAdjacentHTML("beforeend", \'<div class="veil" id="veil"></div>\')',
      );
      await refusal("div");
      await evaluate(
        'document.body.style.pointerEvents = ""; document.getElementById("veil").remove()',
      );

      // A button that turns pointer input off on itself, with nothing over
      // it, keeps the reason that it does not take pointer input.
      await evaluate('document.getElementById("behind").style.pointerEvents = "none"');
      const disabled = await click(behind);
      expect(disabled.state).not.toBe("completed");
      expect(disabled.error?.message).toContain(
        "browser element does not take pointer input (pointer-events: none), which often means it is disabled; use another control",
      );

      // With every block gone, the button takes the click.
      await evaluate('document.getElementById("behind").style.pointerEvents = ""');
      const open = await click(behind);
      expect(open.error ?? null).toBeNull();
      expect(open.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["behind"]);
    });
  },
  60_000,
);

// A confirm opened from a dialog, stacked over the dialog that holds the
// target, and a modal dialog inside a component's open shadow root: the
// document's own query for an open modal finds the first dialog in one and
// nothing in the other, but each is on top over the target.
const STACKED = fixture([
  "<!doctype html><title>Stacked</title>",
  "<style>",
  "body{margin:0;font:14px sans-serif}",
  "#outside{position:absolute;left:40px;top:40px;width:160px;height:40px}",
  "#first{width:300px;height:160px;margin:0;left:40px;top:120px}",
  "#second{width:200px;height:80px;margin:0;left:500px;top:300px}",
  "</style>",
  '<button id="outside">Outside</button>',
  '<dialog id="first" aria-label="First"><button id="inner">Inner</button></dialog>',
  '<dialog id="second" aria-label="Second">Discard changes?</dialog>',
  '<x-dialog id="host"></x-dialog>',
  '<app-shell id="shell"></app-shell>',
  "<script>",
  "globalThis.log=[];",
  'for (const id of ["outside","inner"]) document.getElementById(id).addEventListener("click",()=>log.push(id));',
  'document.getElementById("host").attachShadow({mode:"open"}).innerHTML = \'<dialog style="width:200px;height:80px;margin:0;left:500px;top:300px">Shadow</dialog>\';',
  'document.getElementById("shell").attachShadow({mode:"open"}).innerHTML = "<x-dialog></x-dialog>";',
  'document.getElementById("shell").shadowRoot.querySelector("x-dialog").attachShadow({mode:"open"}).innerHTML = \'<dialog style="width:200px;height:80px;margin:0;left:500px;top:300px">Nested</dialog>\';',
  "</script>",
]);

e2e(
  "a target under a stacked modal or a modal in an open shadow root is covered at its center",
  async () => {
    await withSession(STACKED, async ({ evaluate, click }) => {
      const css = (selector: string) =>
        ({ type: "click", locator: { kind: "css", selector } }) as const;

      // The target's own dialog is open, with a confirm opened over it.
      await evaluate(
        'document.getElementById("first").showModal(); document.getElementById("second").showModal()',
      );
      const stacked = await click(css("#inner"));
      expect(stacked.state).not.toBe("completed");
      expect(stacked.error?.message).toContain(
        'browser element is covered by dialog "Second" at its center',
      );
      // Closing the confirm leaves the target's own dialog on top.
      await evaluate('document.getElementById("second").close()');
      const inner = await click(css("#inner"));
      expect(inner.error ?? null).toBeNull();
      expect(inner.state).toBe("completed");
      await evaluate('document.getElementById("first").close()');

      // A component's modal dialog, inside its open shadow root.
      await evaluate(
        'document.getElementById("host").shadowRoot.querySelector("dialog").showModal()',
      );
      const shadowed = await click(css("#outside"));
      expect(shadowed.state).not.toBe("completed");
      expect(shadowed.error?.message).toContain(
        "browser element is covered by x-dialog at its center",
      );
      await evaluate('document.getElementById("host").shadowRoot.querySelector("dialog").close()');

      // The same dialog component wrapped in an app component: two open
      // shadow roots deep.
      const nestedDialog =
        'document.getElementById("shell").shadowRoot.querySelector("x-dialog").shadowRoot.querySelector("dialog")';
      await evaluate(`${nestedDialog}.showModal()`);
      const nested = await click(css("#outside"));
      expect(nested.state).not.toBe("completed");
      expect(nested.error?.message).toContain(
        "browser element is covered by app-shell at its center",
      );
      await evaluate(`${nestedDialog}.close()`);

      const outside = await click(css("#outside"));
      expect(outside.error ?? null).toBeNull();
      expect(outside.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["inner", "outside"]);
    });
  },
  60_000,
);
