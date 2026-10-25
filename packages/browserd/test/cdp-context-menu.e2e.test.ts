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
  ACCESSIBILITY_CHEAP_REBUILD_NODES,
  AgentBrowserDriver,
  ManagedBrowserRunner,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

/**
 * A file tree whose rows open a custom context menu on right-click, mounted
 * the ways component libraries mount one. Choosing an item writes
 * "Last action: <item> <folder>" to the status line.
 */
const MENU_STYLE =
  '[role="menu"]{background:white;border:1px solid #888;padding:4px;min-width:160px}[role="menuitem"]{display:block;width:100%;text-align:left}';
const MENU_ITEMS =
  '<button role="menuitem">Rename</button><button role="menuitem">Duplicate</button><button role="menuitem">Delete</button>';
const ROWS = ["Reports", "Invoices", "Photos"]
  .map(
    (name) =>
      `<div role="treeitem" tabindex="0" aria-haspopup="menu" style="padding:8px">${name}</div>`,
  )
  .join("");
const CHOOSE =
  'const choose=(item,folder)=>{document.querySelector("output").textContent=`Last action: ${item} ${folder}`};';

const FIXTURES: Record<string, string> = {
  // A web component renders the tree in its shadow root and shows the menu
  // through a named slot: on right-click it adds the slot, makes its anchor
  // visible and covers the tree with an aria-hidden click shield; the menu
  // itself is assigned to the slot one task later.
  "late slotted shadow-root menu": `<!doctype html><title>Files</title><style>${MENU_STYLE}</style><main><h1>Files</h1><file-tree aria-label="Folders"></file-tree><output>Last action: none</output></main><script>${CHOOSE}customElements.define("file-tree",class extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:"open"});root.innerHTML=\`<style>[data-anchor]{position:absolute;top:0;right:0;z-index:50;display:none}[data-anchor][data-visible="true"]{display:flex}[data-anchor]>slot{display:block;position:absolute;left:24px;top:0}[data-shield]{position:absolute;inset:0;z-index:49}.root{position:relative;width:420px}</style><div class="root"><div role="tree" aria-label="Folders">${ROWS}</div><div data-anchor><button aria-label="Options" tabindex="-1">...</button></div></div>\`;root.addEventListener("contextmenu",(event)=>{const row=event.target.closest?.('[role="treeitem"]');if(!row)return;event.preventDefault();this.open(row.textContent,row)});}open(folder,row){const root=this.shadowRoot;const anchor=root.querySelector("[data-anchor]");anchor.style.top=row.offsetTop+"px";const slot=Object.assign(document.createElement("slot"),{name:"context-menu"});anchor.append(slot);anchor.dataset.visible="true";const shield=document.createElement("div");shield.dataset.shield="";shield.setAttribute("aria-hidden","true");root.querySelector(".root").append(shield);setTimeout(()=>{const wrapper=document.createElement("div");wrapper.slot="context-menu";wrapper.innerHTML='<div role="menu">${MENU_ITEMS}</div>';wrapper.addEventListener("click",(event)=>{const item=event.target.closest('[role="menuitem"]');if(!item)return;choose(item.textContent,folder);wrapper.remove();slot.remove();shield.remove();anchor.dataset.visible="false"});this.append(wrapper);wrapper.querySelector("button").focus()},0)}});</script>`,
  // The menu is portalled to the end of <body>; the rest of the page is
  // aria-hidden and pointer-events are off outside the menu, as modal menus
  // in common React component libraries do.
  "portal menu with aria-hidden siblings": `<!doctype html><title>Files</title><style>${MENU_STYLE}</style><div id="app"><main><h1>Files</h1><div role="tree" aria-label="Folders">${ROWS}</div><output>Last action: none</output></main></div><script>${CHOOSE}const app=document.getElementById("app");app.addEventListener("contextmenu",(event)=>{const row=event.target.closest('[role="treeitem"]');if(!row)return;event.preventDefault();const menu=document.createElement("div");menu.setAttribute("role","menu");menu.style.cssText="position:fixed;left:"+event.clientX+"px;top:"+event.clientY+"px;pointer-events:auto";menu.innerHTML='${MENU_ITEMS}';menu.addEventListener("click",(click)=>{const item=click.target.closest('[role="menuitem"]');if(!item)return;choose(item.textContent,row.textContent);menu.remove();app.removeAttribute("aria-hidden");document.body.style.pointerEvents=""});document.body.append(menu);app.setAttribute("aria-hidden","true");document.body.style.pointerEvents="none";menu.querySelector("button").focus()});</script>`,
  // The menu appears a moment after the right-click, as when it is loaded
  // or animated in.
  "menu mounted after the right-click": `<!doctype html><title>Files</title><style>${MENU_STYLE}</style><main><h1>Files</h1><div role="tree" aria-label="Folders">${ROWS}</div><output>Last action: none</output></main><script>${CHOOSE}document.addEventListener("contextmenu",(event)=>{const row=event.target.closest('[role="treeitem"]');if(!row)return;event.preventDefault();setTimeout(()=>{const menu=document.createElement("div");menu.setAttribute("role","menu");menu.style.cssText="position:fixed;left:"+event.clientX+"px;top:"+event.clientY+"px";menu.innerHTML='${MENU_ITEMS}';menu.addEventListener("click",(click)=>{const item=click.target.closest('[role="menuitem"]');if(!item)return;choose(item.textContent,row.textContent);menu.remove()});document.body.append(menu)},300)});</script>`,
  // The menu sits in a focus-trapping modal overlay; the page behind it is
  // inert.
  "focus-trapped overlay menu": `<!doctype html><title>Files</title><style>${MENU_STYLE}.overlay{position:fixed;inset:0;background:rgba(0,0,0,.2)}</style><main id="page"><h1>Files</h1><div role="tree" aria-label="Folders">${ROWS}</div><output>Last action: none</output></main><script>${CHOOSE}const page=document.getElementById("page");page.addEventListener("contextmenu",(event)=>{const row=event.target.closest('[role="treeitem"]');if(!row)return;event.preventDefault();const overlay=document.createElement("div");overlay.className="overlay";overlay.innerHTML='<div role="dialog" aria-modal="true" aria-label="Folder actions" style="position:absolute;left:'+event.clientX+'px;top:'+event.clientY+'px"><div role="menu">${MENU_ITEMS}</div></div>';const items=[...overlay.querySelectorAll("button")];overlay.addEventListener("keydown",(key)=>{if(key.key!=="Tab")return;key.preventDefault();const index=items.indexOf(document.activeElement);items[(index+(key.shiftKey?items.length-1:1))%items.length].focus()});overlay.addEventListener("click",(click)=>{const item=click.target.closest('[role="menuitem"]');if(!item)return;choose(item.textContent,row.textContent);overlay.remove();page.inert=false});document.body.append(overlay);page.inert=true;items[0].focus()});</script>`,
};

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

for (const [index, [variant, html]] of Object.entries(FIXTURES).entries()) {
  e2e(
    `a visible ${variant} is in the outline and acts by ref, role and text`,
    async () => {
      const directory = await mkdtemp("/tmp/ogb-context-menu-");
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
        actor: { kind: "human", subjectId: "context-menu-fixture" },
        observationMode: "full",
        action,
      });
      const run = async (
        observation: BrowserObservation,
        action: BrowserActionCommand["action"],
      ): Promise<BrowserObservation> => {
        const result = await controller.run(command(observation, action));
        expect(result.error ?? null).toBeNull();
        expect(result.state).toBe("completed");
        return result.observation!;
      };
      const status = (observation: BrowserObservation) =>
        nodes(observation).find((node) => node.name?.startsWith("Last action:"))?.name;
      const openMenu = async (observation: BrowserObservation) => {
        await run(observation, {
          type: "click",
          button: "right",
          locator: { kind: "role", role: "treeitem", name: "Invoices", exact: true },
        });
        // Wait for the menu the way an agent would, then read the page.
        await run(observation, {
          type: "wait",
          condition: "visible",
          locator: { kind: "role", role: "menu" },
          timeoutMs: 5_000,
        });
        return await driver.observe(observation.target.id);
      };
      try {
        let observation = await driver.start(`data:text/html,${encodeURIComponent(html)}`);

        // The open menu and every item in it are in the outline.
        observation = await openMenu(observation);
        const items = nodes(observation).filter((node) => node.role === "menuitem");
        expect(items.map((node) => node.name)).toEqual(["Rename", "Duplicate", "Delete"]);

        // Its items act by the ref the outline gave ...
        const duplicate = items.find((node) => node.name === "Duplicate")!;
        observation = await run(observation, {
          type: "click",
          locator: { kind: "ref", ref: duplicate.ref },
        });
        expect(status(observation)).toBe("Last action: Duplicate Invoices");

        // ... by role and name ...
        observation = await openMenu(observation);
        observation = await run(observation, {
          type: "click",
          locator: { kind: "role", role: "menuitem", name: "Rename", exact: true },
        });
        expect(status(observation)).toBe("Last action: Rename Invoices");

        // ... and by their exact text, which part of the text does not match
        // (checked once: a locator that finds nothing waits out its bound).
        observation = await openMenu(observation);
        if (index === 0) {
          const partial = await controller.run(
            command(observation, {
              type: "hover",
              locator: { kind: "text", text: "Delet", exact: true },
            }),
          );
          expect(partial.error?.code).toBe("locator_not_found");
        }
        observation = await run(observation, {
          type: "click",
          locator: { kind: "text", text: "Delete", exact: true },
        });
        expect(status(observation)).toBe("Last action: Delete Invoices");
      } finally {
        await driver.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
}

// On a page too large for routine rebuilds, the outline may miss the
// late-slotted menu, but a locator for one of its items still finds it: the
// look before "not found" rebuilds Chromium's tree.
e2e(
  "on a large page a late-slotted menu item is found before locator_not_found",
  async () => {
    const filler = Array.from(
      { length: 80 },
      (_, index) =>
        `<section><h2>Note ${index}</h2><p>Body ${index} with <a href="#n${index}">a link</a>.</p><ul><li>One</li><li>Two</li><li>Three</li></ul></section>`,
    ).join("");
    const html = FIXTURES["late slotted shadow-root menu"]!.replace("</main>", `${filler}</main>`);
    const directory = await mkdtemp("/tmp/ogb-context-menu-");
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
    const run = async (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ): Promise<BrowserObservation> => {
      const result = await controller.run({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "human", subjectId: "context-menu-fixture" },
        observationMode: "full",
        action,
      });
      expect(result.error ?? null).toBeNull();
      expect(result.state).toBe("completed");
      return result.observation!;
    };
    try {
      let observation = await driver.start(`data:text/html,${encodeURIComponent(html)}`);
      expect(nodes(observation).length).toBeGreaterThan(ACCESSIBILITY_CHEAP_REBUILD_NODES / 4);
      observation = await run(observation, {
        type: "click",
        button: "right",
        locator: { kind: "role", role: "treeitem", name: "Invoices", exact: true },
      });
      observation = await run(observation, {
        type: "click",
        locator: { kind: "role", role: "menuitem", name: "Duplicate", exact: true },
      });
      expect(nodes(observation).find((node) => node.name?.startsWith("Last action:"))?.name).toBe(
        "Last action: Duplicate Invoices",
      );
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
