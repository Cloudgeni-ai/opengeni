import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserAction,
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

// Native date and time inputs. The time input carries an instance-level value
// property, the way UI frameworks track controlled inputs, which ignores
// writes; a fill must still reach the element and notify listeners.
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><html lang="en-US">
<label>Start <input type="time" value="07:00" data-testid="start"></label>
<label>Day <input type="date" value="2026-10-11" data-testid="day"></label>
<label>Locked <input type="date" value="2026-10-11" readonly></label>
<output aria-label="Changes"></output>
<script>
  const log = document.querySelector("output");
  const start = document.querySelector("[data-testid=start]");
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(start, "value", {
    configurable: true,
    get() { return native.get.call(this); },
    set() {},
  });
  for (const input of document.querySelectorAll("input")) {
    for (const type of ["input", "change"]) {
      input.addEventListener(type, () => {
        log.textContent += type + ":" + input.dataset.testid + "=" + input.value + ";";
      });
    }
  }
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
  "fill sets native date and time inputs from the input or any of its parts",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-native-date-time-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `dt_${randomUUID().slice(0, 8)}`,
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
    const dispatch = (observed: BrowserObservation, action: BrowserAction) =>
      driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observed.browserSessionId,
        controllerGeneration: observed.target.controllerGeneration,
        targetId: observed.target.id,
        expectedTargetGeneration: observed.target.targetGeneration,
        expectedDocumentGeneration: observed.target.documentGeneration,
        expectedFrameId: observed.frameId,
        actor: { kind: "system", subjectId: "public-native-date-time-fixture" },
        action,
      } satisfies BrowserActionCommand);
    const fresh = (observed: BrowserObservation) => driver.observe(observed.target.id);
    const changes = (observed: BrowserObservation) =>
      nodes(observed).find(
        (item) => item.role === "text" && /input:|change:/u.test(item.name ?? ""),
      )?.name ?? "";
    try {
      let observed = await driver.start(fixture);

      // Fill is offered on the input, not on the spin buttons of its parts.
      expect(node(observed, "InputTime", "Start")).toMatchObject({
        value: "07:00",
        actions: ["focus", "fill"],
      });
      const hours = node(observed, "spinbutton", "Hours Hours");
      expect(hours.actions).not.toContain("fill");

      // A part-sized value is refused before anything changes.
      await expect(
        dispatch(observed, {
          type: "fill",
          locator: { kind: "ref", ref: hours.ref },
          value: "10",
        }),
      ).rejects.toMatchObject({
        code: "invalid_action",
        message: expect.stringContaining("HH:MM"),
      });
      observed = await fresh(observed);
      expect(node(observed, "InputTime", "Start").value).toBe("07:00");
      expect(changes(observed)).toBe("");

      // A whole value through one of its parts sets the input.
      observed = await dispatch(observed, {
        type: "fill",
        locator: { kind: "ref", ref: node(observed, "spinbutton", "Hours Hours").ref },
        value: "10:30",
      });
      observed = await fresh(observed);
      expect(node(observed, "InputTime", "Start").value).toBe("10:30");
      expect(changes(observed)).toBe("input:start=10:30;change:start=10:30;");

      // The input itself, by test id, in its own format.
      observed = await dispatch(observed, {
        type: "fill",
        locator: { kind: "test_id", value: "day" },
        value: "2026-12-24",
      });
      observed = await fresh(observed);
      expect(node(observed, "Date", "Day").value).toBe("2026-12-24");

      // Locale-formatted text is refused without clearing the value.
      await expect(
        dispatch(observed, {
          type: "fill",
          locator: { kind: "test_id", value: "day" },
          value: "24.12.2026",
        }),
      ).rejects.toMatchObject({
        code: "invalid_action",
        message: expect.stringContaining("YYYY-MM-DD"),
      });
      observed = await fresh(observed);
      expect(node(observed, "Date", "Day").value).toBe("2026-12-24");

      // Read-only inputs are refused.
      await expect(
        dispatch(observed, {
          type: "fill",
          locator: { kind: "ref", ref: node(observed, "Date", "Locked").ref },
          value: "2027-01-01",
        }),
      ).rejects.toMatchObject({ code: "invalid_action" });

      // An empty value clears the input.
      observed = await dispatch(observed, {
        type: "fill",
        locator: { kind: "test_id", value: "day" },
        value: "",
      });
      observed = await fresh(observed);
      expect(node(observed, "Date", "Day").value ?? "").toBe("");
    } finally {
      await driver.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
