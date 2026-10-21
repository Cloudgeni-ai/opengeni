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

// Custom popup controls as web apps build them: a combobox whose hidden list
// it does not reference and that scrolls, one that names its popup and only
// renders options while open, a multi-select listbox, and a combobox with a
// referenced list that lacks the requested option.
const countries = [
  "Argentina",
  "Brazil",
  "Canada",
  "Chile",
  "Denmark",
  "Egypt",
  "Finland",
  "Iceland",
  "India",
  "Japan",
  "Kenya",
  "Mexico",
];
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><html lang="en-US">
<label id="cl">Country</label>
<div id="combo" role="combobox" aria-labelledby="cl" aria-expanded="false" aria-haspopup="listbox" tabindex="0">Select a country</div>
<ul id="lb" role="listbox" hidden style="max-height:60px;overflow:auto;margin:0">
${countries.map((country) => `<li role="option">${country}</li>`).join("")}
</ul>
<label id="sl">Size</label>
<button id="size" type="button" aria-labelledby="sl" aria-haspopup="listbox" aria-controls="sizes" aria-expanded="false">M</button>
<div id="sizes" role="listbox"></div>
<label id="tl">Toppings</label>
<div role="listbox" aria-labelledby="tl" aria-multiselectable="true">
<div role="option" aria-selected="false">Cheese</div><div role="option" aria-selected="false">Ham</div><div role="option" aria-selected="false">Olives</div>
</div>
<label id="ml">Month</label>
<div id="month" role="combobox" aria-labelledby="ml" aria-controls="months" aria-expanded="false" tabindex="0">January</div>
<div id="months" role="listbox" hidden><div role="option">January</div><div role="option">February</div></div>
<output aria-label="Opens">0</output>
<script>
  let opens = 0;
  const count = () => { opens += 1; document.querySelector("output").textContent = String(opens); };
  const combo = document.getElementById("combo"), lb = document.getElementById("lb");
  combo.onclick = () => { count(); lb.hidden = !lb.hidden; combo.setAttribute("aria-expanded", String(!lb.hidden)); };
  lb.querySelectorAll("li").forEach((li) => li.onclick = () => { combo.textContent = li.textContent; lb.hidden = true; combo.setAttribute("aria-expanded", "false"); });
  const size = document.getElementById("size"), sizes = document.getElementById("sizes");
  size.onclick = () => {
    count();
    sizes.innerHTML = ["S", "M", "L", "XL"].map((s) => '<div role="option">' + s + '</div>').join("");
    size.setAttribute("aria-expanded", "true");
    sizes.querySelectorAll("[role=option]").forEach((o) => o.onclick = () => { size.textContent = o.textContent; sizes.innerHTML = ""; size.setAttribute("aria-expanded", "false"); });
  };
  document.querySelectorAll('[aria-multiselectable] [role=option]').forEach((o) => o.onclick = () => o.setAttribute("aria-selected", String(o.getAttribute("aria-selected") !== "true")));
  document.getElementById("month").onclick = count;
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

e2e(
  "select chooses a custom popup control's option by its label",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-popup-select-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `ps_${randomUUID().slice(0, 8)}`,
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
    const select = (observed: BrowserObservation, role: string, name: string, values: string[]) =>
      driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observed.browserSessionId,
        controllerGeneration: observed.target.controllerGeneration,
        targetId: observed.target.id,
        expectedTargetGeneration: observed.target.targetGeneration,
        expectedDocumentGeneration: observed.target.documentGeneration,
        expectedFrameId: observed.frameId,
        actor: { kind: "system", subjectId: "public-popup-select-fixture" },
        action: {
          type: "select",
          locator: { kind: "ref", ref: node(observed, role, name).ref },
          values,
        },
      } satisfies BrowserActionCommand);
    try {
      let observed = await driver.start(fixture);

      // Opens the unreferenced list, scrolls to the option and picks it in
      // one action; the label match ignores case.
      observed = await select(observed, "combobox", "Country", ["japan"]);
      expect(node(observed, "combobox", "Country").value).toBe("Japan");

      // A popup that renders its options only once opened.
      observed = await select(observed, "button", "Size", ["XL"]);
      expect(node(observed, "button", "Size").name).toBe("Size");
      observed = await driver.observe(observed.target.id);
      expect(nodes(observed).some((item) => item.role === "text" && item.name === "XL")).toBe(true);

      // A multi-select listbox takes several options without opening.
      observed = await select(observed, "listbox", "Toppings", ["Cheese", "Olives"]);
      const toppings = (node(observed, "listbox", "Toppings").children ?? []).filter(
        (child) => child.role === "option",
      );
      expect(toppings.map((option) => option.name)).toEqual(["Cheese", "Ham", "Olives"]);
      expect(toppings.map((option) => option.states?.includes("selected") ?? false)).toEqual([
        true,
        false,
        true,
      ]);

      // A missing option in a referenced list is refused before any input,
      // naming the options there are.
      const opensBefore = node(observed, "status", "Opens");
      let failure: { code: string; message: string } | null = null;
      try {
        await select(observed, "combobox", "Month", ["March"]);
      } catch (error) {
        failure = error as { code: string; message: string };
      }
      expect(failure?.code).toBe("invalid_action");
      expect(failure?.message).toBe(
        'this combobox has no option labeled "March"; its options are "January", "February"',
      );
      observed = await driver.observe(observed.target.id);
      expect(node(observed, "status", "Opens")).toEqual(opensBefore);
      expect(JSON.stringify(opensBefore)).toContain('"2"');

      // One option only for a single-choice control.
      failure = null;
      try {
        await select(observed, "combobox", "Country", ["Chile", "Kenya"]);
      } catch (error) {
        failure = error as { code: string; message: string };
      }
      expect(failure?.code).toBe("invalid_action");
      expect(failure?.message).toContain("takes one option");
    } finally {
      await driver.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
