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
const srcdoc = (html: string) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

// A project page whose sticky header shrinks once the page scrolls, which
// moves everything below it up. The tab links and a card sit below the fold,
// with a banner right under them and a drop zone further down. Scroll
// anchoring is off, as on many pages whose layout it would fight. `react` is
// how the page applies the change: in the scroll listener itself, in the
// frame after it, or debounced. The page logs each click on the link and
// each press and release, with the header's state at that moment.
const projectPage = (react: string, linkStyle = "", script = "") =>
  [
    "<!doctype html><title>Project</title>",
    "<style>",
    "html{overflow-anchor:none}",
    "body{margin:0;font:14px sans-serif}",
    "header{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #ccc}",
    "#title{height:160px}",
    "header.compact #title{height:20px}",
    "#intro{height:1200px}",
    "nav a{display:inline-block;padding:8px 16px}",
    "#card,#done{width:200px;height:40px;background:#ddf}",
    "#banner{height:600px;background:#eee}",
    "#rest{height:3000px}",
    "@keyframes drift{from{transform:translateX(0)}to{transform:translateX(6px)}}",
    linkStyle,
    "</style>",
    '<header id="header"><div id="title">Office renovation</div></header>',
    '<div id="intro">Overview</div>',
    '<nav aria-label="Package"><a href="#builder" id="builder">Builder</a><a href="#customer">Customer</a></nav>',
    '<div id="card" role="button" aria-label="Card">Card</div>',
    '<section id="banner" aria-label="Preview">This package is not published yet</section>',
    '<div id="done" role="button" aria-label="Done">Done</div>',
    '<div id="rest"></div>',
    "<script>",
    "globalThis.log=[];globalThis.scrolledAt=null;",
    'const state=()=>document.getElementById("header").className||"tall";',
    'const where=(event)=>event.target.closest("[id]")?.id;',
    'document.getElementById("builder").addEventListener("click",(event)=>{event.preventDefault();log.push("builder "+state());globalThis.waited=Math.round(performance.now()-scrolledAt)});',
    'document.getElementById("banner").addEventListener("click",()=>log.push("banner"));',
    'document.addEventListener("pointerdown",(event)=>{if(where(event)!=="builder")log.push("down "+where(event)+" "+state())});',
    'document.addEventListener("pointerup",(event)=>{if(where(event)!=="builder")log.push("up "+where(event))});',
    'addEventListener("scroll",()=>{scrolledAt??=performance.now()});',
    'const apply=()=>document.getElementById("header").classList.toggle("compact",scrollY>40);',
    `addEventListener("scroll",${react});`,
    script,
    "</script>",
  ].join("");

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

// The pointer's arrival on a link in a centered column opens a fixed overlay
// and locks the page's scrolling, which shifts the column (and the link) a
// few pixels sideways: the link is covered, not moved away.
const SCROLL_LOCK = fixture([
  "<!doctype html><title>Lock</title>",
  "<style>",
  "body{margin:0;font:14px sans-serif}",
  "#column{max-width:600px;margin:0 auto;height:3000px}",
  "#column.locked{position:relative;left:8px}",
  "a{display:inline-block;padding:8px 16px}",
  "#overlay{position:fixed;inset:0;display:none;background:rgba(0,0,0,.2)}",
  "</style>",
  '<div id="column"><div style="height:200px">Plans</div><a href="#pricing" id="pricing">Pricing</a></div>',
  '<section id="overlay" aria-label="Newsletter">Sign up for our newsletter</section>',
  "<script>",
  "globalThis.log=[];",
  'document.getElementById("pricing").addEventListener("click",(event)=>{event.preventDefault();log.push("pricing")});',
  'document.getElementById("pricing").addEventListener("pointerenter",()=>{document.getElementById("overlay").style.display="block";document.documentElement.style.overflow="hidden";document.getElementById("column").classList.add("locked")});',
  "</script>",
]);

interface Session {
  evaluate: (expression: string) => Promise<unknown>;
  act: (action: BrowserActionCommand["action"]) => ReturnType<BrowserInteractionController["run"]>;
  /** Runs the action and times the controller's run alone, not its observation. */
  timed: (
    action: BrowserActionCommand["action"],
  ) => Promise<{ result: Awaited<ReturnType<BrowserInteractionController["run"]>>; ms: number }>;
  /** How many times the driver has waited for the page to settle after its
   * own scroll. */
  settles: () => number;
}

const link = (name: string) => ({ kind: "role", role: "link", name, exact: true }) as const;
const button = (name: string) => ({ kind: "role", role: "button", name, exact: true }) as const;

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
  // Count the driver's waits after its own scroll, where it has them.
  let settleCount = 0;
  const internals = driver as unknown as {
    settleAfterScroll?: (...args: unknown[]) => Promise<void>;
  };
  const settle = internals.settleAfterScroll?.bind(driver);
  if (settle) {
    internals.settleAfterScroll = async (...args: unknown[]) => {
      settleCount += 1;
      await settle(...args);
    };
  }
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
    const act = async (action: BrowserActionCommand["action"]) =>
      await controller.run(command(await driver.observe(initial.target.id), action));
    const timed = async (action: BrowserActionCommand["action"]) => {
      const prepared = command(await driver.observe(initial.target.id), action);
      const started = performance.now();
      const result = await controller.run(prepared);
      return { result, ms: performance.now() - started };
    };
    await body({ evaluate, act, timed, settles: () => settleCount });
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
      await withSession(fixture([projectPage(react)]), async ({ evaluate, act, settles }) => {
        expect(
          await evaluate(
            'document.getElementById("builder").getBoundingClientRect().top > innerHeight',
          ),
        ).toBe(true);
        const result = await act({ type: "click", locator: link("Builder") });
        expect(result.error ?? null).toBeNull();
        expect(result.state).toBe("completed");
        // Only the link took the click, once the page had finished reacting
        // to the scroll: a click aimed while the header was still tall lands
        // wherever the link is when the header shrinks.
        expect(await evaluate("log")).toEqual(["builder compact"]);
        expect(settles()).toBe(1);
      });
    },
    60_000,
  );
}

for (const [page, script] of [
  ["", ""],
  // Page timers and frame callbacks that never run do not hold the drag:
  // the wait runs out of the page's reach, on the driver's own clock.
  [
    " on a page that replaces its timers",
    "requestAnimationFrame=()=>0;setTimeout=()=>0;setInterval=()=>0;",
  ],
] as const) {
  e2e(
    `a drag from below the fold presses its source after the sticky header shrinks${page}`,
    async () => {
      await withSession(
        fixture([projectPage("apply", "", script)]),
        async ({ evaluate, timed }) => {
          const { result, ms } = await timed({
            type: "drag",
            from: button("Card"),
            to: button("Done"),
          });
          expect(result.error ?? null).toBeNull();
          expect(result.state).toBe("completed");
          expect(await evaluate("log")).toEqual(["down card compact", "up done"]);
          expect(ms).toBeLessThan(5_000);
        },
      );
    },
    60_000,
  );
}

e2e(
  "a link below the fold in a child frame is clicked after the frame's sticky header shrinks",
  async () => {
    const page = fixture([
      "<!doctype html><title>Framed</title><style>body{margin:0}iframe{display:block;border:0;width:100vw;height:100vh}</style>",
      `<iframe title="Project" srcdoc="${srcdoc(projectPage("apply"))}"></iframe>`,
    ]);
    await withSession(page, async ({ evaluate, act }) => {
      expect(
        await evaluate(
          'new Promise((resolve) => { const check = () => document.querySelector("iframe").contentDocument?.getElementById("builder") ? resolve(true) : setTimeout(check, 20); check(); })',
        ),
      ).toBe(true);
      const result = await act({ type: "click", locator: link("Builder") });
      expect(result.error ?? null).toBeNull();
      expect(result.state).toBe("completed");
      expect(await evaluate('document.querySelector("iframe").contentWindow.log')).toEqual([
        "builder compact",
      ]);
    });
  },
  60_000,
);

e2e(
  "a link that keeps moving is clicked once the wait after the scroll reaches its limit",
  async () => {
    const page = fixture([
      projectPage("apply", "#builder{animation:drift .4s infinite alternate linear}"),
    ]);
    await withSession(page, async ({ evaluate, timed }) => {
      const { result, ms } = await timed({ type: "click", locator: link("Builder") });
      expect(result.error ?? null).toBeNull();
      expect(result.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["builder compact"]);
      // The click waited out the 600 ms limit after its scroll (the page's
      // own scroll event can come a slow frame later, so the action's run is
      // timed), and then went ahead rather than waiting on.
      expect(ms).toBeGreaterThanOrEqual(600);
      expect((await evaluate("waited")) as number).toBeLessThan(2_500);
    });
  },
  60_000,
);

// A page that renders its rows anew as it scrolls (a virtual or endless
// list) removes or replaces the link, or hides it, while the driver waits for
// the scroll to settle. The click refuses plainly, with nothing pressed.
for (const [change, script, refusal] of [
  [
    "removes the link",
    'document.getElementById("builder").remove()',
    "(locator_not_found: browser element is no longer present)",
  ],
  [
    "replaces the link with a look-alike",
    'const old=document.getElementById("builder");old.replaceWith(old.cloneNode(true))',
    "(locator_not_found: browser element is no longer present)",
  ],
  [
    "hides the link",
    'document.getElementById("builder").style.display="none"',
    "(invalid_action: browser element has no box on the page to act on; it is hidden or not rendered)",
  ],
] as const) {
  e2e(
    `a click refuses plainly when the page ${change} while the driver waits after its scroll`,
    async () => {
      const page = fixture([
        projectPage(
          "apply",
          "",
          [
            'document.addEventListener("pointerdown",(event)=>log.push("press "+where(event)),true);',
            'document.addEventListener("click",(event)=>log.push("click "+where(event)),true);',
            `addEventListener("scroll",()=>setTimeout(()=>{${script}},60),{once:true});`,
          ].join(""),
        ),
      ]);
      await withSession(page, async ({ evaluate, act, settles }) => {
        const result = await act({ type: "click", locator: link("Builder") });
        // The driver's scroll ran the page's scroll listeners, so the outcome
        // stays unknown, but the receipt says plainly why nothing was pressed.
        expect(result.state).toBe("outcome_unknown");
        expect(result.error?.message).toContain(refusal);
        expect(result.error?.message).not.toContain("box model");
        expect(settles()).toBe(1);
        expect(await evaluate("log")).toEqual([]);
      });
    },
    60_000,
  );
}

e2e(
  "a link that moves from under the arriving pointer is refused as moved; a real cover keeps its refusal",
  async () => {
    await withSession(HOVER, async ({ evaluate, act, settles }) => {
      const moved = await act({ type: "click", locator: link("Builder") });
      expect(moved.state).toBe("outcome_unknown");
      expect(moved.error?.message).toContain(
        '(invalid_action: browser element moved as the click was sent, so the press fell on section "Preview"; the click was not delivered; click it again)',
      );
      expect(await evaluate("log")).toEqual([]);
      // Clicked again, where it now is, it takes the click. It is in view, so
      // nothing scrolls and neither click waited for the page to settle.
      const again = await act({ type: "click", locator: link("Builder") });
      expect(again.error ?? null).toBeNull();
      expect(again.state).toBe("completed");
      expect(settles()).toBe(0);
      expect(await evaluate("log")).toEqual(["builder"]);

      const covered = await act({ type: "click", locator: link("Customer") });
      expect(covered.state).toBe("outcome_unknown");
      expect(covered.error?.message).toContain(
        '(invalid_action: browser element is covered by section "Newsletter" at its center; the click was not delivered)',
      );
      expect(await evaluate("log")).toEqual(["builder"]);
    });
  },
  60_000,
);

e2e(
  "a link that the pointer's arrival covers and nudges sideways is refused as covered",
  async () => {
    await withSession(SCROLL_LOCK, async ({ evaluate, act }) => {
      const covered = await act({ type: "click", locator: link("Pricing") });
      expect(covered.state).toBe("outcome_unknown");
      expect(covered.error?.message).toContain(
        '(invalid_action: browser element is covered by section "Newsletter" at its center; the click was not delivered)',
      );
      // The link did shift under the pointer, but the press still fell
      // inside it, where the overlay took it.
      expect(await evaluate('document.getElementById("column").classList.contains("locked")')).toBe(
        true,
      );
      expect(await evaluate("log")).toEqual([]);
    });
  },
  60_000,
);
