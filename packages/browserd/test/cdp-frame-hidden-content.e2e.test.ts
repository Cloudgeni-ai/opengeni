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

// The same promises as in the main frame (cdp-hidden-open-menu and
// cdp-pointer-decoration), for content inside a child frame: one from the
// page's own origin, rendered in the page's process, and one from another
// site, rendered in its own process with its own CDP session.
const FRAMES = ["same-origin", "cross-origin"] as const;
type FrameKind = (typeof FRAMES)[number];

const POINTER_EVENTS_NONE =
  "browser element does not take pointer input (pointer-events: none), which often means it is disabled; use another control";

/** Inside the frame: logs every click it sees, by what was clicked, and
 * every run of pointer moves, to the page, which keeps them in `log`. */
const FRAME_LOG = `<script>
let last=null;const send=(entry)=>{last=entry;top.postMessage({frameLog:entry},"*")};
document.addEventListener("pointermove",()=>{if(last!=="move")send("move")},true);
document.addEventListener("click",(event)=>{const target=event.target instanceof Element?event.target:event.target.parentElement;send("click "+(target.getAttribute("aria-label")||target.id||target.textContent.trim()||target.className))},true);
</script>`;

const STYLE =
  "nav{display:flex;gap:16px;padding:8px;background:#eee}.dd{position:relative}.sub{display:none;position:absolute;top:100%;left:0;background:white;border:1px solid #888;padding:4px;min-width:160px;z-index:10}.dd.open .sub{display:block}.sub a,.sub div{display:block;padding:4px}";
const CHOOSE =
  'document.addEventListener("click",(event)=>{const item=event.target.closest("[data-item]");if(item)document.querySelector("output").textContent="Last action: "+item.textContent;});';
const OPEN =
  'document.querySelector(".dd > button").addEventListener("click",()=>document.querySelector(".dd").classList.add("open"));';
const menuPage = (menu: string, script = OPEN) =>
  `<!doctype html><title>Admin</title><style>${STYLE}</style><nav><a href="#home">Home</a><div class="dd"><button>Administration</button>${menu}</div></nav><main><h1>Dashboard</h1><output>Last action: none</output></main><script>${CHOOSE}${script}</script>`;

/** Dropdowns the frame shows on screen while their markup still hides them
 * with aria-hidden (see cdp-hidden-open-menu). */
const MENUS: Record<string, string> = {
  "a stale aria-hidden link list": menuPage(
    '<ul class="sub" aria-hidden="true"><li><a href="#users" data-item>Users</a></li><li><a href="#roles" data-item>Roles</a></li></ul>',
  ),
  "an aria-hidden submenu": menuPage(
    '<div class="sub" role="menu"><div role="menuitem" aria-haspopup="true" data-item>Access</div><div role="menu" aria-hidden="true" style="position:absolute;left:100%;top:0;background:white;border:1px solid #888"><div role="menuitem" data-item>Users</div><div role="menuitem" data-item>Roles</div></div></div>',
  ),
  "a late portal into an aria-hidden container": menuPage(
    '<div id="portal" aria-hidden="true"></div>',
    'document.querySelector(".dd > button").addEventListener("click",()=>setTimeout(()=>{document.getElementById("portal").innerHTML=\'<div class="sub" style="display:block;position:fixed;top:44px;left:72px"><div data-item style="cursor:pointer">Users</div><div data-item style="cursor:pointer">Roles</div></div>\'},300));',
  ),
};

/** What a person cannot see or press stays hidden inside a frame too. */
const HIDDEN = `<!doctype html><title>Closed</title><style>${STYLE}</style><main>
<div class="dd"><button>Settings</button><ul class="sub" aria-hidden="true"><li><a href="#closed">Closed item</a></li></ul></div>
<button aria-label="Save"><span aria-hidden="true">Disk icon</span></button></main>`;

/** Comboboxes with chevrons drawn over them that take no pointer input, one
 * of them only drawn (see cdp-pointer-decoration). */
const COMBOBOXES = `<!doctype html><title>Pick</title><style>.field{position:relative;width:260px;margin:8px}.field input{width:100%;box-sizing:border-box;padding:6px 32px 6px 6px}.chevron{position:absolute;right:2px;top:2px;bottom:2px;width:28px;pointer-events:none;border:0;background:#ddd}</style><main>
<label for="country">Country</label><div class="field"><input id="country" role="combobox" aria-expanded="false"><button class="chevron" tabindex="-1" aria-label="browse options">v</button></div>
<label for="size">Size</label><div class="field"><input id="size" role="combobox" aria-expanded="false"><span class="chevron">&#9662;</span></div>
</main>${FRAME_LOG}<script>
for(const box of document.querySelectorAll("[role=combobox]"))box.addEventListener("click",()=>{box.setAttribute("aria-expanded","true");send("open "+box.id)});
</script>`;

/** Buttons and links disabled only by a class that turns their pointer off. */
const DISABLED_BY_CLASS = `<!doctype html><title>Wizard</title><style>.disabled{pointer-events:none;opacity:.65}.footer{display:flex;gap:8px;padding:8px;width:300px}</style><div class="footer"><button>Back</button><button class="disabled">Next</button></div><div class="footer"><a href="#open">Open</a><a href="#delete" class="btn disabled">Delete</a></div>${FRAME_LOG}`;

/** A row action that takes the pointer only while its row is hovered. */
const HOVER_ENABLED = `<!doctype html><title>Rows</title><style>.go{pointer-events:none}tr:hover .go{pointer-events:auto}</style><table><tr><td>Row one</td><td><button class="go">Go</button></td></tr></table>${FRAME_LOG}`;

/** The same row action, armed only once the pointer has rested on its row
 * for a moment, as rows and menus that wait for hover intent do: the frame
 * applies the hover well after the move has reached it. */
const HOVER_ENABLED_AFTER_REST = HOVER_ENABLED.replace("tr:hover .go", "tr.armed .go").replace(
  "</table>",
  '</table><script>const row=document.querySelector("tr");row.addEventListener("pointerenter",()=>setTimeout(()=>row.classList.add("armed"),200));row.addEventListener("pointerleave",()=>row.classList.remove("armed"));</script>',
);

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

/** A page that holds `frameHtml` in an iframe of the given kind, with what
 * the frame logs kept in the page's `log`. */
async function withFramedPage(
  kind: FrameKind,
  frameHtml: string,
  body: (tools: {
    observation: BrowserObservation;
    observe: () => Promise<BrowserObservation>;
    act: (
      action: BrowserActionCommand["action"],
    ) => ReturnType<BrowserInteractionController["run"]>;
    run: (action: BrowserActionCommand["action"]) => Promise<BrowserObservation>;
    log: () => Promise<string[]>;
    evaluate: (expression: string) => Promise<unknown>;
  }) => Promise<void>,
  hostScript = "",
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-frame-hidden-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  // 127.0.0.1 and localhost are different sites, so Chromium renders a
  // frame from the other one in its own process.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const frameOrigin =
        kind === "cross-origin" ? `http://localhost:${url.port}` : `http://127.0.0.1:${url.port}`;
      return new Response(
        url.pathname === "/frame"
          ? frameHtml
          : `<!doctype html><title>Host</title><style>body{margin:0}h1{margin:4px 8px;font-size:16px}iframe{display:block;width:640px;height:320px;border:1px solid #888;margin:8px}</style><h1>Host page</h1><iframe title="Embedded app" src="${frameOrigin}/frame"></iframe><script>globalThis.log=[];globalThis.loaded=false;document.querySelector("iframe").addEventListener("load",()=>{loaded=true});addEventListener("message",(event)=>{if(event.data&&typeof event.data.frameLog==="string")log.push(event.data.frameLog)});${hostScript}</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
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
    const initial = await driver.start(`http://127.0.0.1:${server.port}/`);
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
    for (let i = 0; i < 100 && (await evaluate("loaded")) !== true; i += 1) await Bun.sleep(50);
    expect(await evaluate("loaded")).toBe(true);
    const observation = await driver.observe(initial.target.id);
    const act = (action: BrowserActionCommand["action"]) =>
      controller.run({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "human", subjectId: "frame-hidden-content-fixture" },
        observationMode: "full",
        action,
      });
    await body({
      observation,
      observe: () => driver.observe(initial.target.id),
      act,
      run: async (action) => {
        const result = await act(action);
        expect(result.error ?? null).toBeNull();
        expect(result.state).toBe("completed");
        return result.observation!;
      },
      log: async () => {
        // Frame messages arrive a task after the input.
        await Bun.sleep(150);
        return ((await evaluate("log")) as string[]).filter((entry) => entry !== "move");
      },
      evaluate,
    });
  } finally {
    await cdp?.close();
    await driver.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

const status = (observation: BrowserObservation) =>
  nodes(observation).find((node) => node.name?.startsWith("Last action:"))?.name;

for (const kind of FRAMES) {
  for (const [variant, html] of Object.entries(MENUS)) {
    e2e(
      `in a ${kind} frame, an open dropdown shown on screen from ${variant} is in the outline and acts by text and ref`,
      async () => {
        await withFramedPage(kind, html, async ({ observe, run }) => {
          let observation = await run({
            type: "click",
            locator: { kind: "role", role: "button", name: "Administration", exact: true },
          });
          // Wait for an item by its text, as an agent would, then read the page.
          await run({
            type: "wait",
            condition: "visible",
            locator: { kind: "text", text: "Roles", exact: true },
            timeoutMs: 5_000,
          });
          observation = await observe();
          const texts = nodes(observation)
            .filter((node) => node.role === "text")
            .map((node) => node.name);
          expect(texts).toContain("Users");
          expect(texts).toContain("Roles");
          observation = await run({
            type: "click",
            locator: { kind: "text", text: "Users", exact: true },
          });
          expect(status(observation)).toBe("Last action: Users");
          observation = await observe();
          const roles =
            nodes(observation).find((node) => node.name === "Roles" && node.role !== "text") ??
            nodes(observation).find((node) => node.name === "Roles")!;
          observation = await run({ type: "click", locator: { kind: "ref", ref: roles.ref } });
          expect(status(observation)).toBe("Last action: Roles");
        });
      },
      90_000,
    );
  }

  e2e(
    `in a ${kind} frame, a closed menu and an icon's hidden text stay out of the outline`,
    async () => {
      await withFramedPage(kind, HIDDEN, async ({ observe }) => {
        const names = nodes(await observe()).map((node) => node.name);
        expect(names).toContain("Settings");
        expect(names).toContain("Save");
        expect(names).not.toContain("Closed item");
        expect(names).not.toContain("Disk icon");
      });
    },
    90_000,
  );

  e2e(
    `in a ${kind} frame, a chevron control that takes no pointer input is refused with nothing pressed, and a drawn chevron is pressed through to its combobox`,
    async () => {
      await withFramedPage(kind, COMBOBOXES, async ({ observation, act, log }) => {
        expect(nodes(observation).some((node) => node.name === "browse options")).toBe(true);
        const refused = await act({
          type: "click",
          locator: { kind: "role", role: "button", name: "browse options", exact: true },
        });
        expect(refused.state).toBe("failed");
        expect(refused.error?.code).toBe("invalid_action");
        expect(refused.error?.message).toBe(POINTER_EVENTS_NONE);
        expect(await log()).toEqual([]);
        const size = await act({
          type: "click",
          locator: { kind: "text", text: "\u25BE", exact: true },
        });
        expect(size.error ?? null).toBeNull();
        expect(size.state).toBe("completed");
        expect(await log()).toEqual(["click size", "open size"]);
      });
    },
    90_000,
  );

  e2e(
    `in a ${kind} frame, a button or link disabled by a pointer-events: none class stays in the outline and a click on it is a definite refusal`,
    async () => {
      await withFramedPage(kind, DISABLED_BY_CLASS, async ({ observation, act, log }) => {
        const listed = nodes(observation);
        expect(listed.some((node) => node.role === "button" && node.name === "Next")).toBe(true);
        expect(listed.some((node) => node.role === "link" && node.name === "Delete")).toBe(true);
        for (const [role, name] of [
          ["button", "Next"],
          ["link", "Delete"],
        ] as const) {
          const clicked = await act({
            type: "click",
            locator: { kind: "role", role, name, exact: true },
          });
          expect(clicked.state).toBe("failed");
          expect(clicked.error?.code).toBe("invalid_action");
          expect(clicked.error?.message).toBe(POINTER_EVENTS_NONE);
        }
        expect(await log()).toEqual([]);
      });
    },
    90_000,
  );

  e2e(
    `in a ${kind} frame, a visible control that takes the pointer only on hover is hovered and clicked`,
    async () => {
      await withFramedPage(kind, HOVER_ENABLED, async ({ act, log }) => {
        const clicked = await act({
          type: "click",
          locator: { kind: "role", role: "button", name: "Go", exact: true },
        });
        expect(clicked.error ?? null).toBeNull();
        expect(clicked.state).toBe("completed");
        expect(await log()).toEqual(["click Go"]);
      });
    },
    90_000,
  );

  e2e(
    `in a ${kind} frame, a visible control that takes the pointer only once the pointer has rested on its row is hovered and clicked`,
    async () => {
      await withFramedPage(kind, HOVER_ENABLED_AFTER_REST, async ({ act, log }) => {
        const clicked = await act({
          type: "click",
          locator: { kind: "role", role: "button", name: "Go", exact: true },
        });
        expect(clicked.error ?? null).toBeNull();
        expect(clicked.state).toBe("completed");
        expect(await log()).toEqual(["click Go"]);
      });
    },
    90_000,
  );

  e2e(
    `in a ${kind} frame, a refusal after the hover's move stays an unknown outcome when the frame reacts to the pointer`,
    async () => {
      await withFramedPage(
        kind,
        DISABLED_BY_CLASS.replace(
          "</div>",
          '</div><script>document.querySelector(".footer").addEventListener("pointerover",()=>{if(!document.body.dataset.entered){document.body.dataset.entered="yes";send("entered")}})</script>',
        ),
        async ({ act, log }) => {
          const clicked = await act({
            type: "click",
            locator: { kind: "role", role: "button", name: "Next", exact: true },
          });
          expect(await log()).toEqual(["entered"]);
          expect(clicked.state).toBe("outcome_unknown");
          expect(clicked.error?.code).toBe("outcome_unknown");
        },
      );
    },
    90_000,
  );
}

// Chromium does not tell a page that the pointer left it for a cross-origin
// frame (no pointerout or mouseleave reaches the page), so only a frame from
// the page's own origin shows the page reacting.
e2e(
  "in a same-origin frame, a refusal after the hover's move stays an unknown outcome when the page holding the frame reacts to the pointer leaving it",
  async () => {
    await withFramedPage(
      "same-origin",
      DISABLED_BY_CLASS,
      async ({ act, run, evaluate }) => {
        // The pointer rests on the page's heading, which notes when it leaves.
        await run({
          type: "hover",
          locator: { kind: "role", role: "heading", name: "Host page", exact: true },
        });
        expect(await evaluate("document.body.dataset.left")).toBeUndefined();
        const clicked = await act({
          type: "click",
          locator: { kind: "role", role: "button", name: "Next", exact: true },
        });
        expect(await evaluate("document.body.dataset.left")).toBe("yes");
        expect(clicked.state).toBe("outcome_unknown");
        expect(clicked.error?.code).toBe("outcome_unknown");
      },
      'document.querySelector("h1").addEventListener("pointerout",()=>{document.body.dataset.left="yes"});',
    );
  },
  90_000,
);
