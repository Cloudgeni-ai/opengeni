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

const POINTER_EVENTS_NONE =
  "browser element does not take pointer input (pointer-events: none), which often means it is disabled; use another control";

/** Logs every click the page sees, by what was clicked, and every run of
 * pointer moves. */
const LOG = `<script>
globalThis.log=[];
document.addEventListener("pointermove",()=>{if(log.at(-1)!=="move")log.push("move")},true);
document.addEventListener("click",(event)=>{const target=event.target instanceof Element?event.target:event.target.parentElement;log.push("click "+(target.getAttribute("aria-label")||target.id||target.textContent.trim()||target.className))},true);
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

async function withPage(
  html: string,
  body: (tools: {
    outline: () => Promise<InteractionSemanticNodeValue[]>;
    act: (
      action: BrowserActionCommand["action"],
    ) => ReturnType<BrowserInteractionController["run"]>;
    evaluate: (expression: string) => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
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
    const initial = await driver.start(`data:text/html,${encodeURIComponent(html)}`);
    const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
    cdp = await CdpConnection.connect(endpoint.cdpUrl);
    const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: initial.target.id,
      flatten: true,
    });
    await body({
      outline: async () => nodes(await driver.observe(initial.target.id)),
      act: (action) =>
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
        }),
      evaluate: async (expression) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value,
    });
  } finally {
    await cdp?.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Comboboxes with a "browse options" chevron drawn over the field that takes
 * no pointer input (pointer-events: none), so a person's click on it reaches
 * what lies beneath. Each combobox records when a click opens it.
 */
const COMBOBOXES = `<!doctype html><title>Pick</title><style>.field{position:relative;width:260px;margin:8px}.field input{width:100%;box-sizing:border-box;padding:6px 32px 6px 6px}.chevron{position:absolute;right:2px;top:2px;bottom:2px;width:28px;pointer-events:none;border:0;background:#ddd}.frame{display:flex;position:relative;width:260px;margin:8px;padding:4px;border:1px solid #888}.frame input{width:200px;border:0}.picker{display:block;position:relative;width:260px;height:32px;margin:8px;border:1px solid #888}</style><main>
<label for="country">Country</label><div class="field"><input id="country" role="combobox" aria-expanded="false" aria-autocomplete="list"><button class="chevron" tabindex="-1" aria-label="browse options">v</button></div>
<label for="city">City</label><div class="frame"><input id="city" role="combobox" aria-expanded="false"><span class="chevron" role="button" aria-label="browse cities">v</span></div>
<label for="size">Size</label><div class="field"><input id="size" role="combobox" aria-expanded="false"><span class="chevron">&#9662;</span></div>
<label for="region">Region</label><div class="field"><input id="region" role="combobox" aria-expanded="false"><button class="chevron" tabindex="-1" aria-label="browse regions" aria-disabled="true">v</button></div>
<div class="picker"><button style="pointer-events:none" aria-label="browse nothing">v</button></div>
</main>${LOG}<script>
for(const box of document.querySelectorAll("[role=combobox]"))box.addEventListener("click",()=>{box.setAttribute("aria-expanded","true");log.push("open "+box.id)});
</script>`;

e2e(
  "a control that takes no pointer input stays in the outline and is refused before anything is pressed; a drawn chevron is pressed through to its combobox",
  async () => {
    await withPage(COMBOBOXES, async ({ outline, act, evaluate }) => {
      const named = (found: InteractionSemanticNodeValue[], name: string) =>
        found.filter((node) => node.name === name);
      const listed = await outline();
      // Chevrons that are controls are listed as the page gives them, next
      // to the comboboxes.
      for (const name of ["browse options", "browse cities", "browse regions", "browse nothing"])
        expect(named(listed, name).length).toBe(1);
      expect(named(listed, "Country").some((node) => node.role === "combobox")).toBe(true);
      expect(named(listed, "City").some((node) => node.role === "combobox")).toBe(true);

      // Pressing a chevron control is a definite refusal that says to use
      // another control, and nothing is clicked.
      for (const name of ["browse options", "browse cities", "browse nothing"]) {
        await evaluate("log.length = 0");
        const pressed = await act({
          type: "click",
          locator: { kind: "role", role: "button", name, exact: true },
        });
        expect(pressed.state).toBe("failed");
        expect(pressed.error?.code).toBe("invalid_action");
        expect(pressed.error?.message).toBe(POINTER_EVENTS_NONE);
        expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual(
          [],
        );
      }
      // A disabled chevron is refused too.
      const region = await act({
        type: "click",
        locator: { kind: "role", role: "button", name: "browse regions", exact: true },
      });
      expect(region.state).toBe("failed");
      expect(region.error?.code).toBe("invalid_action");

      // A chevron that is only drawn (no control) is pressed where it shows,
      // which reaches the combobox beneath it, as a person's click does.
      await evaluate("log.length = 0");
      const size = await act({
        type: "click",
        locator: { kind: "text", text: "\u25BE", exact: true },
      });
      expect(size.error ?? null).toBeNull();
      expect(size.state).toBe("completed");
      expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual([
        "click size",
        "open size",
      ]);

      // Typing into the combobox still works.
      const typed = await act({
        type: "fill",
        locator: { kind: "role", role: "combobox", name: "Country", exact: true },
        value: "Nor",
      });
      expect(typed.state).toBe("completed");
      expect(await evaluate('document.getElementById("country").value')).toBe("Nor");
    });
  },
  90_000,
);

/**
 * Buttons and links disabled only by a class that turns their pointer off
 * (Bootstrap's .disabled), each next to one enabled control in a small
 * footer that takes the click instead.
 */
const DISABLED_BY_CLASS = `<!doctype html><title>Wizard</title><style>.disabled{pointer-events:none;opacity:.65}.footer{display:flex;gap:8px;padding:8px;width:300px}</style><div class="footer"><button>Back</button><button class="disabled">Next</button></div><div class="footer"><a href="#open">Open</a><a href="#delete" class="btn disabled">Delete</a></div>${LOG}`;

e2e(
  "a button or link disabled by a pointer-events: none class stays in the outline and a click on it is a definite refusal",
  async () => {
    await withPage(DISABLED_BY_CLASS, async ({ outline, act, evaluate }) => {
      const listed = await outline();
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
      expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual([]);
      expect(await evaluate("location.hash")).toBe("");
    });
  },
  90_000,
);

/** A row action that takes the pointer only while its row is hovered. */
const HOVER_ENABLED = `<!doctype html><title>Rows</title><style>.go{pointer-events:none}tr:hover .go{pointer-events:auto}</style><table><tr><td>Row one</td><td><button class="go">Go</button></td></tr></table>${LOG}`;

e2e(
  "a visible control that takes the pointer only on hover is hovered and clicked",
  async () => {
    await withPage(HOVER_ENABLED, async ({ act, evaluate }) => {
      const clicked = await act({
        type: "click",
        locator: { kind: "role", role: "button", name: "Go", exact: true },
      });
      expect(clicked.error ?? null).toBeNull();
      expect(clicked.state).toBe("completed");
      expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual([
        "click Go",
      ]);
    });
  },
  90_000,
);

/** A row action that the page turns on a moment after the pointer enters
 * its row, as hover-intent menus do. */
const HOVER_ENABLED_LATER = `<!doctype html><title>Rows</title><style>.go{pointer-events:none}.go.on{pointer-events:auto}</style><table><tr id="row"><td>Row one</td><td><button class="go">Go</button></td></tr></table>${LOG}<script>
document.getElementById("row").addEventListener("mouseenter",()=>setTimeout(()=>document.querySelector(".go").classList.add("on"),250));
</script>`;

e2e(
  "a control the page turns on a moment after the hover is not refused as if the page had not reacted",
  async () => {
    await withPage(HOVER_ENABLED_LATER, async ({ act, evaluate }) => {
      const clicked = await act({
        type: "click",
        locator: { kind: "role", role: "button", name: "Go", exact: true },
      });
      expect(clicked.state).toBe("outcome_unknown");
      expect(clicked.error?.code).toBe("outcome_unknown");
      expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual([]);
      expect(await evaluate('document.querySelector(".go").className')).toBe("go on");
    });
  },
  90_000,
);

/**
 * Chevrons whose pointer is off for all they hold: an icon inside one that
 * is only drawn, and a control inside one, each over its combobox.
 */
const NESTED = `<!doctype html><title>Pick</title><style>.field{position:relative;width:260px;margin:8px}.field input{width:100%;box-sizing:border-box;padding:6px 32px 6px 6px}.chevron{position:absolute;right:2px;top:2px;bottom:2px;width:28px;pointer-events:none;background:#ddd}.chevron i,.chevron button{display:block;width:100%;height:100%;border:0;background:none;font-style:normal}</style><main>
<label for="size">Size</label><div class="field"><input id="size" role="combobox" aria-expanded="false"><span class="chevron"><i>&#9662;</i></span></div>
<label for="color">Color</label><div class="field"><input id="color" role="combobox" aria-expanded="false"><span class="chevron"><button tabindex="-1" aria-label="browse colors">v</button></span></div>
</main>${LOG}<script>
for(const box of document.querySelectorAll("[role=combobox]"))box.addEventListener("click",()=>{box.setAttribute("aria-expanded","true");log.push("open "+box.id)});
</script>`;

e2e(
  "an icon inside a drawn chevron is pressed through to its combobox, and a control inside one is refused",
  async () => {
    await withPage(NESTED, async ({ act, evaluate }) => {
      const size = await act({
        type: "click",
        locator: { kind: "text", text: "\u25BE", exact: true },
      });
      expect(size.error ?? null).toBeNull();
      expect(size.state).toBe("completed");
      expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual([
        "click size",
        "open size",
      ]);
      await evaluate("log.length = 0");
      const color = await act({
        type: "click",
        locator: { kind: "role", role: "button", name: "browse colors", exact: true },
      });
      expect(color.state).toBe("failed");
      expect(color.error?.code).toBe("invalid_action");
      expect(color.error?.message).toBe(POINTER_EVENTS_NONE);
      expect(((await evaluate("log")) as string[]).filter((entry) => entry !== "move")).toEqual([]);
    });
  },
  90_000,
);
