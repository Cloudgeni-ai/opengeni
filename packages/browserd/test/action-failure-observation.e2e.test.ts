import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A custom (non-editable) combobox, a native select, a checkbox, a text field,
// and a button that re-renders itself on every click, the way calendar and
// list widgets rebuild their markup.
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><html lang="en-US">
<label id="cl">Country</label>
<div id="combo" role="combobox" aria-labelledby="cl" aria-expanded="false" aria-haspopup="listbox" tabindex="0">Select a country</div>
<label>Plan <select><option>Starter</option><option>Team</option></select></label>
<label><input type="checkbox"> News</label>
<label>Name <input type="text"></label>
<div id="pager"></div>
<output aria-label="Clicks">0</output>
<script>
  let clicks = 0;
  const pager = document.getElementById("pager");
  const draw = () => {
    pager.innerHTML = '<button type="button">Previous month</button>';
    pager.querySelector("button").onclick = () => {
      clicks += 1;
      document.querySelector("output").textContent = String(clicks);
      draw();
    };
  };
  draw();
</script>`)}`;

type Node = InteractionSemanticNodeValue;

function nodes(observed: BrowserObservation): Node[] {
  const all: Node[] = [];
  const visit = (item: Node): void => {
    all.push(item);
    for (const child of item.children ?? []) visit(child);
  };
  const semantic = observed.semantic;
  if (semantic?.kind === "snapshot") for (const root of semantic.roots) visit(root);
  return all;
}

function node(observed: BrowserObservation, role: string, name: string): Node {
  const found = nodes(observed).find((item) => item.role === role && item.name === name);
  if (!found) throw new Error(`no ${role} named ${name}`);
  return found;
}

async function rejection(promise: Promise<unknown>): Promise<{
  code: string;
  message: string;
  observation: BrowserObservation | null;
}> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; observation: BrowserObservation | null };
  }
  throw new Error("expected the action to fail");
}

e2e(
  "failed actions name the working action and carry the page after the failure",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-action-failure-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `af_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const dispatch = (observed: BrowserObservation, action: BrowserActionCommand["action"]) =>
      driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observed.browserSessionId,
        controllerGeneration: observed.target.controllerGeneration,
        targetId: observed.target.id,
        expectedTargetGeneration: observed.target.targetGeneration,
        expectedDocumentGeneration: observed.target.documentGeneration,
        expectedFrameId: observed.frameId,
        actor: { kind: "system", subjectId: "public-action-failure-fixture" },
        action,
      } satisfies BrowserActionCommand);
    try {
      let observed = await driver.start(fixture);

      // Fill on a custom combobox is refused before any input, says to click
      // it, and returns the page so the next step can act at once.
      const combo = node(observed, "combobox", "Country");
      let failure = await rejection(
        dispatch(observed, {
          type: "fill",
          locator: { kind: "ref", ref: combo.ref },
          value: "Norway",
        }),
      );
      expect(failure.code).toBe("invalid_action");
      expect(failure.message).toContain("click it to open its options");
      expect(failure.observation).not.toBeNull();
      expect(node(failure.observation!, "combobox", "Country").name).toBe("Country");

      failure = await rejection(
        dispatch(observed, {
          type: "fill",
          locator: { kind: "ref", ref: node(observed, "combobox", "Plan").ref },
          value: "Team",
        }),
      );
      expect(failure).toMatchObject({ code: "invalid_action" });
      expect(failure.message).toContain("select action");

      failure = await rejection(
        dispatch(observed, {
          type: "fill",
          locator: { kind: "ref", ref: node(observed, "checkbox", "News").ref },
          value: "yes",
        }),
      );
      expect(failure.message).toContain("use check");

      // Text fields still fill.
      observed = await dispatch(observed, {
        type: "fill",
        locator: { kind: "ref", ref: node(observed, "textbox", "Name").ref },
        value: "Ada",
      });
      observed = await driver.observe(observed.target.id);
      // Typed text stays out of observations; a chosen option is shown.
      expect(node(observed, "textbox", "Name").value).toBeUndefined();
      expect(node(observed, "combobox", "Plan").value).toBe("Starter");
      expect(node(observed, "combobox", "Country").value).toBe("Select a country");

      // Clicking one ref twice in a batch fails on the second click because
      // the button re-rendered; the receipt carries its fresh ref.
      const previous = node(observed, "button", "Previous month");
      failure = await rejection(
        dispatch(observed, {
          type: "batch",
          fenceEachAction: true,
          actions: [
            { type: "click", locator: { kind: "ref", ref: previous.ref } },
            { type: "click", locator: { kind: "ref", ref: previous.ref } },
          ],
        }),
      );
      expect(failure.code).toBe("outcome_unknown");
      expect(failure.message).toContain("check the current page");
      expect(failure.observation).not.toBeNull();
      const rerendered = node(failure.observation!, "button", "Previous month");
      expect(rerendered.ref).not.toBe(previous.ref);
      expect(node(failure.observation!, "status", "Clicks").name).toBe("Clicks");

      // A stale ref alone fails definitely, also with the current page.
      failure = await rejection(
        dispatch(failure.observation!, {
          type: "click",
          locator: { kind: "ref", ref: previous.ref },
        }),
      );
      expect(failure.code).toBe("locator_not_found");
      expect(node(failure.observation!, "button", "Previous month").ref).toBe(rerendered.ref);

      // Without a post-action view, failures stay bare.
      observed = await driver.observe(observed.target.id);
      failure = await rejection(
        driver.dispatch({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId: observed.browserSessionId,
          controllerGeneration: observed.target.controllerGeneration,
          targetId: observed.target.id,
          expectedTargetGeneration: observed.target.targetGeneration,
          expectedDocumentGeneration: observed.target.documentGeneration,
          expectedFrameId: observed.frameId,
          actor: { kind: "system", subjectId: "public-action-failure-fixture" },
          observationMode: "none",
          action: { type: "click", locator: { kind: "ref", ref: previous.ref } },
        } satisfies BrowserActionCommand),
      );
      expect(failure.code).toBe("locator_not_found");
      expect(failure.observation).toBeNull();
    } finally {
      await driver.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
