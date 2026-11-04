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

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";

/**
 * A navigation bar whose "Administration" button opens a dropdown that the
 * page shows on screen while its markup still hides it from assistive
 * technology with aria-hidden, the ways sites leave it hidden. Choosing an
 * item writes "Last action: <item>" to the status line.
 */
const STYLE =
  "nav{display:flex;gap:16px;padding:8px;background:#eee}.dd{position:relative}.sub{display:none;position:absolute;top:100%;left:0;background:white;border:1px solid #888;padding:4px;min-width:160px;z-index:10}.dd.open .sub{display:block}.sub a,.sub div{display:block;padding:4px}";
const CHOOSE =
  'document.addEventListener("click",(event)=>{const item=event.target.closest("[data-item]");if(item)document.querySelector("output").textContent="Last action: "+item.textContent;});';
const OPEN =
  'document.querySelector(".dd > button").addEventListener("click",()=>document.querySelector(".dd").classList.add("open"));';
const page = (menu: string, script = OPEN) =>
  `<!doctype html><title>Admin</title><style>${STYLE}</style><nav><a href="#home">Home</a><div class="dd"><button>Administration</button>${menu}</div></nav><main><h1>Dashboard</h1><output>Last action: none</output></main><script>${CHOOSE}${script}</script>`;

const FIXTURES: Record<string, string> = {
  // A list of links shown by a class, its aria-hidden never updated.
  "a stale aria-hidden link list": page(
    '<ul class="sub" aria-hidden="true"><li><a href="#users" data-item>Users</a></li><li><a href="#roles" data-item>Roles</a></li></ul>',
  ),
  // A menu with menu roles, itself marked aria-hidden.
  "an aria-hidden menu": page(
    '<div class="sub" role="menu" aria-hidden="true"><div role="menuitem" tabindex="-1" data-item>Users</div><div role="menuitem" tabindex="-1" data-item>Roles</div></div>',
  ),
  // A submenu, marked aria-hidden, open beside the item that opened it.
  // Chromium leaves everything inside it out of its tree.
  "an aria-hidden submenu": page(
    '<div class="sub" role="menu"><div role="menuitem" aria-haspopup="true" data-item>Access</div><div role="menu" aria-hidden="true" style="position:absolute;left:100%;top:0;background:white;border:1px solid #888"><div role="menuitem" data-item>Users</div><div role="menuitem" data-item>Roles</div></div></div>',
  ),
  // Rendered a moment after the click into a portal container at the end of
  // the page that is aria-hidden, as a container left hidden by an earlier
  // modal would be.
  "a late portal into an aria-hidden container": page(
    '<div id="portal" aria-hidden="true"></div>',
    'document.querySelector(".dd > button").addEventListener("click",()=>setTimeout(()=>{document.getElementById("portal").innerHTML=\'<div class="sub" style="display:block;position:fixed;top:44px;left:72px"><div data-item style="cursor:pointer">Users</div><div data-item style="cursor:pointer">Roles</div></div>\'},300));',
  ),
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

async function withBrowser(
  html: string,
  body: (tools: {
    observation: BrowserObservation;
    observe: (observation: BrowserObservation) => Promise<BrowserObservation>;
    act: (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ) => ReturnType<BrowserInteractionController["run"]>;
    run: (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ) => Promise<BrowserObservation>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-hidden-menu-");
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
  const act = (observation: BrowserObservation, action: BrowserActionCommand["action"]) =>
    controller.run({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "hidden-menu-fixture" },
      observationMode: "full",
      action,
    });
  const run = async (observation: BrowserObservation, action: BrowserActionCommand["action"]) => {
    const result = await act(observation, action);
    expect(result.error ?? null).toBeNull();
    expect(result.state).toBe("completed");
    return result.observation!;
  };
  try {
    const observation = await driver.start(`data:text/html,${encodeURIComponent(html)}`);
    await body({
      observation,
      observe: (current) => driver.observe(current.target.id),
      act,
      run,
    });
  } finally {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const status = (observation: BrowserObservation) =>
  nodes(observation).find((node) => node.name?.startsWith("Last action:"))?.name;

for (const [variant, html] of Object.entries(FIXTURES)) {
  e2e(
    `an open dropdown shown on screen from ${variant} is in the outline and acts by text and ref`,
    async () => {
      await withBrowser(html, async ({ observation: initial, observe, run }) => {
        const open = async (observation: BrowserObservation) => {
          observation = await run(observation, {
            type: "click",
            locator: { kind: "role", role: "button", name: "Administration", exact: true },
          });
          // Wait for an item by its text, as an agent would, then read the page.
          await run(observation, {
            type: "wait",
            condition: "visible",
            locator: { kind: "text", text: "Roles", exact: true },
            timeoutMs: 5_000,
          });
          return await observe(observation);
        };
        let observation = await open(initial);
        const texts = nodes(observation)
          .filter((node) => node.role === "text")
          .map((node) => node.name);
        expect(texts).toContain("Users");
        expect(texts).toContain("Roles");

        // By its exact text ...
        observation = await run(observation, {
          type: "click",
          locator: { kind: "text", text: "Users", exact: true },
        });
        expect(status(observation)).toBe("Last action: Users");

        // ... and by the ref the outline gave it (the menu stays open).
        observation = await observe(observation);
        const roles = nodes(observation).find(
          (node) => node.name === "Roles" && node.role !== "text",
        );
        const target = roles ?? nodes(observation).find((node) => node.name === "Roles")!;
        observation = await run(observation, {
          type: "click",
          locator: { kind: "ref", ref: target.ref },
        });
        expect(status(observation)).toBe("Last action: Roles");
      });
    },
    90_000,
  );
}

e2e(
  "aria-hidden content a person can press joins the outline without taking over exact text, and what they cannot see or press stays out",
  async () => {
    const html = `<!doctype html><title>Admin</title><style>${STYLE}.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.3)}</style><main><h1>Dashboard</h1>
      <div class="dd"><button>Settings</button><ul class="sub" aria-hidden="true"><li><a href="#closed">Closed item</a></li></ul></div>
      <button aria-label="Save"><span aria-hidden="true">Disk icon</span></button>
      <div id="behind" aria-hidden="true"><a href="#behind">Behind the backdrop</a></div>
      <div class="slides"><a href="#first">First slide</a><div aria-hidden="true"><a href="#first-copy" tabindex="-1">First slide</a></div></div>
      <output>Last action: none</output></main>
      <script>${CHOOSE}document.querySelectorAll("a").forEach((link)=>link.addEventListener("click",(event)=>{event.preventDefault();document.querySelector("output").textContent="Last action: "+link.getAttribute("href")}));
      const behind=document.getElementById("behind");const cover=document.createElement("div");cover.className="backdrop";const box=behind.getBoundingClientRect();cover.style.cssText="position:fixed;left:0;right:0;top:"+(box.top-4)+"px;height:"+(box.height+8)+"px;background:rgba(0,0,0,.3)";document.body.append(cover);</script>`;
    await withBrowser(html, async ({ observation: initial, observe, run }) => {
      const observation = await observe(initial);
      const names = nodes(observation).map((node) => node.name);
      // A closed menu, an icon's text and content under a backdrop stay out.
      expect(names).not.toContain("Closed item");
      expect(names).not.toContain("Disk icon");
      expect(names).not.toContain("Behind the backdrop");
      // A visible copy that a person can press joins the outline, but the
      // exact text still names the copy the page exposes.
      const slides = nodes(observation).filter(
        (node) => node.role === "link" && node.name === "First slide",
      );
      expect(slides.length).toBe(2);
      const clicked = await run(observation, {
        type: "click",
        locator: { kind: "text", text: "First slide", exact: true },
      });
      expect(status(clicked)).toBe("Last action: #first");
    });
  },
  90_000,
);
