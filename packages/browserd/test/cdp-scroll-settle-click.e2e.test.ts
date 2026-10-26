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

const fixture = (lines: string[]) => `data:text/html,${encodeURIComponent(lines.join(""))}`;

// A project page whose sticky header shrinks once the page scrolls, which
// moves everything below it up. The tab links sit below the fold, with a
// banner right under them. Scroll anchoring is off, as on many pages whose
// layout it would fight. `react` is how the page applies the change: in the
// scroll listener itself, in the frame after it, or debounced.
const page = (react: string) =>
  fixture([
    "<!doctype html><title>Project</title>",
    "<style>",
    "html{overflow-anchor:none}",
    "body{margin:0;font:14px sans-serif}",
    "header{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #ccc}",
    "#title{height:160px}",
    "header.compact #title{height:20px}",
    "#intro{height:1200px}",
    "nav a{display:inline-block;padding:8px 16px}",
    "#banner{height:600px;background:#eee}",
    "#rest{height:3000px}",
    "</style>",
    '<header id="header"><div id="title">Office renovation</div></header>',
    '<div id="intro">Overview</div>',
    '<nav aria-label="Package"><a href="#builder" id="builder">Builder</a><a href="#customer">Customer</a></nav>',
    '<section id="banner" aria-label="Preview">This package is not published yet</section>',
    '<div id="rest"></div>',
    "<script>",
    "globalThis.log=[];",
    // The link records the header's state when the click reaches it.
    'document.getElementById("builder").addEventListener("click",(event)=>{event.preventDefault();log.push("builder "+(document.getElementById("header").className||"tall"))});',
    'document.getElementById("banner").addEventListener("click",()=>log.push("banner"));',
    'const apply=()=>document.getElementById("header").classList.toggle("compact",scrollY>40);',
    `addEventListener("scroll",${react});`,
    "</script>",
  ]);

// The pointer's arrival on a link collapses the panel above it, so the link
// moves up from under the pointer before the press; or it opens an overlay
// over the link.
const HOVER = fixture([
  "<!doctype html><title>Hover</title>",
  "<style>",
  "html{overflow-anchor:none}",
  "body{margin:0;font:14px sans-serif}",
  "#panel{height:300px}",
  "#panel.collapsed{height:40px}",
  "a{display:inline-block;padding:8px 16px}",
  "#banner{height:600px;background:#eee}",
  "#overlay{position:fixed;inset:0;display:none;background:rgba(0,0,0,.2)}",
  "</style>",
  '<div id="panel">Details</div>',
  '<nav aria-label="Package"><a href="#builder" id="builder">Builder</a><a href="#customer" id="customer">Customer</a></nav>',
  '<section id="banner" aria-label="Preview">This package is not published yet</section>',
  '<section id="overlay" aria-label="Newsletter">Sign up for our newsletter</section>',
  "<script>",
  "globalThis.log=[];",
  'for (const id of ["builder","customer"]) document.getElementById(id).addEventListener("click",(event)=>{event.preventDefault();log.push(id)});',
  'document.getElementById("banner").addEventListener("click",()=>log.push("banner"));',
  'document.getElementById("builder").addEventListener("pointerenter",()=>document.getElementById("panel").classList.add("collapsed"));',
  'document.getElementById("customer").addEventListener("pointerenter",()=>{document.getElementById("overlay").style.display="block"});',
  "</script>",
]);

interface Session {
  evaluate: (expression: string) => Promise<unknown>;
  click: (name: string) => ReturnType<BrowserInteractionController["run"]>;
}

async function withSession(url: string, body: (session: Session) => Promise<void>) {
  const directory = await mkdtemp("/tmp/ogb-scroll-settle-click-");
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
    actor: { kind: "human", subjectId: "scroll-settle-click-fixture" },
    observationMode: "none",
    action,
  });
  try {
    const initial = await driver.start(url);
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
    const click = async (name: string) =>
      await controller.run(
        command(await driver.observe(initial.target.id), {
          type: "click",
          locator: { kind: "role", role: "link", name, exact: true },
        }),
      );
    await body({ evaluate, click });
  } finally {
    await cdp?.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [when, react] of [
  ["in its scroll listener", "apply"],
  ["in the frame after the scroll", "()=>requestAnimationFrame(apply)"],
  ["50 ms after the scroll", "()=>setTimeout(apply,50)"],
] as const) {
  e2e(
    `a link below the fold is clicked after the sticky header shrinks ${when}`,
    async () => {
      await withSession(page(react), async ({ evaluate, click }) => {
        expect(
          await evaluate(
            'document.getElementById("builder").getBoundingClientRect().top > innerHeight',
          ),
        ).toBe(true);
        const result = await click("Builder");
        expect(result.error ?? null).toBeNull();
        expect(result.state).toBe("completed");
        // Only the link took the click, once the page had finished reacting
        // to the scroll: a click aimed while the header was still tall lands
        // wherever the link is when the header shrinks.
        expect(await evaluate("log")).toEqual(["builder compact"]);
      });
    },
    60_000,
  );
}

e2e(
  "a link that moves from under the arriving pointer is refused as moved; a real cover keeps its refusal",
  async () => {
    await withSession(HOVER, async ({ evaluate, click }) => {
      const moved = await click("Builder");
      expect(moved.state).toBe("outcome_unknown");
      expect(moved.error?.message).toContain(
        '(invalid_action: browser element moved as the click was sent, so the press fell on section "Preview"; the click was not delivered; click it again)',
      );
      expect(await evaluate("log")).toEqual([]);
      // Clicked again, where it now is, it takes the click.
      const again = await click("Builder");
      expect(again.error ?? null).toBeNull();
      expect(again.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["builder"]);

      const covered = await click("Customer");
      expect(covered.state).toBe("outcome_unknown");
      expect(covered.error?.message).toContain(
        '(invalid_action: browser element is covered by section "Newsletter" at its center; the click was not delivered)',
      );
      expect(await evaluate("log")).toEqual(["builder"]);
    });
  },
  60_000,
);
