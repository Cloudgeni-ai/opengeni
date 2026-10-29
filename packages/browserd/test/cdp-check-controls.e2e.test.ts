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

const toggle = `onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))"`;
const box = `<span style="position: absolute; left: 0; top: 0; width: 18px; height: 18px; border: 1px solid; background: #fff"></span>`;
// A native checkbox that takes no pointer input, placed over its label.
const hiddenBox = (id: string) =>
  `<input type="checkbox" id="${id}" style="pointer-events: none; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; margin: 0">`;

// Checkboxes and switches as component libraries draw them: ARIA roles on
// buttons and divs, and native inputs that take no pointer input under a box
// their label draws.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Checkable controls</title>
<style>body { font: 14px sans-serif; margin: 20px } p { margin: 12px 0 }</style>
<p><button role="checkbox" aria-checked="false" id="terms" ${toggle}>Accept terms</button></p>
<p><div role="switch" tabindex="0" aria-checked="false" aria-label="Dark mode" id="dark"
  style="width: 40px; height: 20px; border: 1px solid" ${toggle}></div></p>
<p><div role="switch" tabindex="0" aria-checked="false" aria-label="Sync" id="sync"
  style="width: 40px; height: 20px; border: 1px solid"
  onclick="setTimeout(() => this.setAttribute('aria-checked', 'true'), 1500)"></div></p>
<p><div role="checkbox" tabindex="0" aria-checked="false" aria-label="Locked" id="locked"
  style="width: 20px; height: 20px; border: 1px solid"></div></p>
<p><input type="checkbox" id="news"><label for="news">Newsletter</label></p>
<p style="position: relative">${hiddenBox("category")}
  <label for="category" style="position: relative; display: inline-block; padding-left: 28px; line-height: 20px">${box}Category A</label>
</p>`;

// Labels that hold a link, a control re-rendered on click, and radio buttons.
const SERVED = `<!doctype html><meta charset="utf-8"><title>Labels and replacements</title>
<style>body { font: 14px sans-serif; margin: 20px } p { margin: 12px 0 }</style>
<p style="position: relative">${hiddenBox("consent")}<label for="consent"
  style="display: inline-block; padding-left: 24px">I agree to the <a href="#terms">Terms of Service and the Privacy Policy of this site</a></label></p>
<p style="position: relative">${hiddenBox("accept")}<label for="accept"
  style="display: inline-block; padding-left: 24px">I accept the <a href="/other">Terms of Service and the Privacy Policy of this website</a></label></p>
<p style="position: relative">${hiddenBox("updates")}<label for="updates"
  style="position: relative; display: inline-block; padding-left: 28px; line-height: 20px">${box}Send me updates, see the <a href="/other">privacy notice for the details of it all</a></label></p>
<p><button role="checkbox" aria-checked="false" id="rendered"
  onclick="const next = this.cloneNode(true); next.setAttribute('aria-checked', 'true'); this.replaceWith(next)">Re-rendered</button></p>
<p><input type="radio" name="size" id="small" checked onclick="window.radioClicks = (window.radioClicks || 0) + 1"><label for="small">Small</label>
  <input type="radio" name="size" id="large"><label for="large">Large</label></p>`;

// Checkable controls whose markup the earlier ones do not cover: a hidden
// input beside a label that draws its box (as Fluent UI's checkbox), a label
// wrapping a box drawn with an ARIA role, ARIA roles and states in other
// cases or after a role the browser does not know, and a custom element that
// sets its own role and state. Each shows in observe as a checkbox or switch.
const MORE = `<!doctype html><meta charset="utf-8"><title>More checkable controls</title>
<style>body { font: 14px sans-serif; margin: 20px } p { margin: 12px 0 } .box { display: inline-block; width: 16px; height: 16px; border: 1px solid; vertical-align: middle }</style>
<p style="position: relative"><input type="checkbox" id="policies" style="position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0">
  <label for="policies"><span class="box"></span> <span>I agree to the platform policies</span></label></p>
<p><label><span class="box" role="checkbox" tabindex="0" aria-checked="false" id="wrapped" ${toggle}></span> Remember this device</label></p>
<p><div role="Switch" tabindex="0" aria-checked="false" aria-label="Upper case role" id="upper" class="box" ${toggle}></div></p>
<p><div role="custom-box checkbox" tabindex="0" aria-checked="false" aria-label="Fallback role" id="fallback" class="box" ${toggle}></div></p>
<p><div role="checkbox" tabindex="0" aria-checked="TRUE" aria-label="Upper case state" id="caps" class="box"
  onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked').toLowerCase() === 'true' ? 'false' : 'true')"></div></p>
<p><x-check id="custom" tabindex="0" aria-label="Custom element" class="box"></x-check></p>
<p><button aria-pressed="false" id="pressed" onclick="this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'))">Bold</button></p>
<script>
customElements.define("x-check", class extends HTMLElement {
  constructor() {
    super();
    this.internals = this.attachInternals();
    this.internals.role = "checkbox";
    this.internals.ariaChecked = "false";
    this.addEventListener("click", () => {
      this.internals.ariaChecked = this.internals.ariaChecked === "true" ? "false" : "true";
    });
  }
});
</script>`;

e2e(
  "check and click work on checkboxes and switches as people see them",
  async () => {
    await withPage(
      `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`,
      async ({ act, read }) => {
        const role = (name: string, kind = "checkbox") =>
          ({ kind: "role", role: kind, name, exact: true }) as const;

        // ARIA checkbox and switch: the state is aria-checked.
        expect(
          (await act({ type: "check", locator: role("Accept terms"), checked: true })).state,
        ).toBe("completed");
        expect(await read("terms.getAttribute('aria-checked')")).toBe("true");
        expect(
          (await act({ type: "check", locator: role("Accept terms"), checked: false })).state,
        ).toBe("completed");
        expect(await read("terms.getAttribute('aria-checked')")).toBe("false");
        expect(
          (await act({ type: "check", locator: role("Dark mode", "switch"), checked: true })).state,
        ).toBe("completed");
        expect(await read("dark.getAttribute('aria-checked')")).toBe("true");

        // A switch that shows its new state only once it has saved.
        expect(
          (await act({ type: "check", locator: role("Sync", "switch"), checked: true })).state,
        ).toBe("completed");
        expect(await read("sync.getAttribute('aria-checked')")).toBe("true");

        // A control that does not change says so instead of reporting success.
        const locked = await act({ type: "check", locator: role("Locked"), checked: true });
        expect(locked.state).toBe("outcome_unknown");
        expect(locked.error?.message).toBe(
          "the control was clicked but does not show checked; look at it before clicking it again",
        );

        // A label stands for its control.
        expect(
          (
            await act({
              type: "check",
              locator: { kind: "css", selector: "label[for=news]" },
              checked: true,
            })
          ).state,
        ).toBe("completed");
        expect(await read("news.checked")).toBe(true);

        // A native checkbox that takes no pointer input, drawn by its label:
        // check and click both reach it through the box the label draws.
        expect(
          (await act({ type: "check", locator: role("Category A"), checked: true })).state,
        ).toBe("completed");
        expect(await read("category.checked")).toBe(true);
        expect((await act({ type: "click", locator: role("Category A") })).state).toBe("completed");
        expect(await read("category.checked")).toBe(false);
      },
    );
  },
  90_000,
);

e2e(
  "a label's link is never clicked for its control, and a replaced or radio control is read right",
  async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new Response(
          new URL(request.url).pathname === "/other"
            ? "<!doctype html><title>Other</title><h1>Terms</h1>"
            : SERVED,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    try {
      await withPage(`http://127.0.0.1:${server.port}/`, async ({ act, read }) => {
        const css = (selector: string) => ({ kind: "css", selector }) as const;
        const where = async () => await read("location.pathname + location.hash");

        // Where the only spot of the label to click is a link, to this page
        // or another, neither check nor click follows it: the control keeps
        // its refusal and the page stays.
        for (const id of ["consent", "accept"]) {
          for (const action of [
            { type: "check", locator: css(`#${id}`), checked: true },
            { type: "click", locator: css(`#${id}`) },
          ] as const) {
            const result = await act(action);
            expect({
              id,
              type: action.type,
              state: result.state,
              code: result.error?.code,
            }).toEqual({ id, type: action.type, state: "failed", code: "invalid_action" });
            expect(await where()).toBe("/");
            expect(await read(`${id}.checked`)).toBe(false);
          }
        }

        // A label with a link and a drawn box is clicked on the box.
        expect((await act({ type: "check", locator: css("#updates"), checked: true })).state).toBe(
          "completed",
        );
        expect(await read("updates.checked")).toBe(true);
        expect((await act({ type: "click", locator: css("#updates") })).state).toBe("completed");
        expect(await read("updates.checked")).toBe(false);
        expect(await where()).toBe("/");

        // The page puts a new control in place of the one clicked.
        expect((await act({ type: "check", locator: css("#rendered"), checked: true })).state).toBe(
          "completed",
        );
        expect(await read("rendered.getAttribute('aria-checked')")).toBe("true");

        // A radio button turns off only through another option: refused
        // without a click.
        const off = await act({ type: "check", locator: css("#small"), checked: false });
        expect(off.state).toBe("failed");
        expect(off.error?.message).toBe(
          "a radio button turns off only when another option in its group is chosen; check that option instead",
        );
        expect(await read("[small.checked, window.radioClicks ?? 0]")).toEqual([true, 0]);
        expect((await act({ type: "check", locator: css("#large"), checked: true })).state).toBe(
          "completed",
        );
        expect(await read("[small.checked, large.checked]")).toEqual([false, true]);
      });
    } finally {
      await server.stop(true);
    }
  },
  90_000,
);

type Page = {
  act: (action: BrowserActionCommand["action"]) => ReturnType<BrowserInteractionController["run"]>;
  read: (expression: string) => Promise<unknown>;
  observe: () => Promise<BrowserObservation>;
};

e2e(
  "check works on whatever observe shows as a checkbox, switch or radio button",
  async () => {
    await withPage(
      `data:text/html;charset=utf-8,${encodeURIComponent(MORE)}`,
      async ({ act, read, observe }) => {
        const roles = new Map<string, string>();
        const walk = (nodes: readonly InteractionSemanticNodeValue[]) => {
          for (const node of nodes) {
            if (node.name && node.role !== "text") roles.set(node.name, node.role);
            walk(node.children ?? []);
          }
        };
        const observation = await observe();
        walk(observation.semantic?.kind === "snapshot" ? observation.semantic.roots : []);
        expect({
          policies: roles.get("I agree to the platform policies"),
          upper: roles.get("Upper case role"),
          fallback: roles.get("Fallback role"),
          caps: roles.get("Upper case state"),
          custom: roles.get("Custom element"),
        }).toEqual({
          policies: "checkbox",
          upper: "switch",
          fallback: "checkbox",
          caps: "checkbox",
          custom: "checkbox",
        });
        const text = (value: string) => ({ kind: "text", text: value, exact: true }) as const;
        const role = (name: string, kind = "checkbox") =>
          ({ kind: "role", role: kind, name, exact: true }) as const;
        const check = async (
          locator: Extract<BrowserActionCommand["action"], { type: "check" }>["locator"],
          checked: boolean,
        ) => {
          const result = await act({ type: "check", locator, checked });
          return result.state === "completed"
            ? "completed"
            : `${result.state}: ${result.error?.message}`;
        };

        // The text of a label beside a hidden input stands for its control.
        expect(await check(text("I agree to the platform policies"), true)).toBe("completed");
        expect(await read("policies.checked")).toBe(true);
        expect(await check(role("I agree to the platform policies"), false)).toBe("completed");
        expect(await read("policies.checked")).toBe(false);

        // A label wrapping a box drawn with an ARIA role stands for the box.
        expect(await check(text("Remember this device"), true)).toBe("completed");
        expect(await read("wrapped.getAttribute('aria-checked')")).toBe("true");

        // ARIA roles and states in any case, and a role after one the browser
        // does not know.
        expect(await check(role("Upper case role", "switch"), true)).toBe("completed");
        expect(await read("upper.getAttribute('aria-checked')")).toBe("true");
        expect(await check(role("Fallback role"), true)).toBe("completed");
        expect(await read("fallback.getAttribute('aria-checked')")).toBe("true");
        expect(await check(role("Upper case state"), false)).toBe("completed");
        expect(await read("caps.getAttribute('aria-checked')")).toBe("false");

        // A custom element's own role and state, which its markup does not show.
        expect(await check(role("Custom element"), true)).toBe("completed");
        expect(await read("custom.internals.ariaChecked")).toBe("true");
        expect(await check(role("Custom element"), true)).toBe("completed");
        expect(await read("custom.internals.ariaChecked")).toBe("true");

        // Anything else is refused without a click, saying what to do instead.
        const pressed = await act({
          type: "check",
          locator: { kind: "css", selector: "#pressed" },
          checked: true,
        });
        expect({
          state: pressed.state,
          code: pressed.error?.code,
          message: pressed.error?.message,
        }).toEqual({
          state: "failed",
          code: "invalid_action",
          message:
            "browser locator is not a checkbox, switch or radio button; to toggle something else, click it and then look at it",
        });
        expect(await read("pressed.getAttribute('aria-pressed')")).toBe("false");
      },
    );
  },
  90_000,
);

async function withPage(url: string, body: (page: Page) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-check-controls-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
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
    const start = await driver.start(url);
    const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
    cdp = await CdpConnection.connect(endpoint.cdpUrl);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: start.target.id,
      flatten: true,
    });
    await body({
      observe: async () => await driver.observe(start.target.id),
      act: async (action) =>
        await controller.run(command(await driver.observe(start.target.id), action)),
      read: async (expression) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId },
          )
        ).result.value,
    });
  } finally {
    cdp?.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-check-controls-e2e" },
    action,
  };
}
