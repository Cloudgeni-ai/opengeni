import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSecretReference,
  referenceKey,
  type BrowserActionCommand,
  type BrowserObservation,
  type InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "observations show form field values, and an ordinary field shows what was filled into it, but never passwords",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-field-values-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
    });
    try {
      const start = await driver.start(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>Fields</title>
        <label>Name <input value="Ada Lovelace"></label>
        <label>Draft <textarea>Reference 4821-amber
second line</textarea></label>
        <label>Search <input type="search" value="norway fjords"></label>
        <label>Password <input type="password" id="pw"></label>
        <label>API key <input></label>
        <p id="echo"></p>
        <script>
          // Built at runtime so the value is not in this data URL.
          document.getElementById('pw').value = 'hunter' + '22-' + 'secret';
          document.querySelector('label:nth-of-type(5) input').addEventListener('input', (event) => {
            document.getElementById('echo').textContent = 'Key ends ' + event.target.value;
            document.title = 'Key ' + event.target.value;
            location.hash = 'key=' + encodeURIComponent(event.target.value);
            // Clipped at 4096 characters partway through the value, then
            // joined with the next argument.
            console.log('x'.repeat(4088) + event.target.value, 'marker');
          });
        </script>`)}`,
      );
      expect(valueOf(start, "textbox", "Name")).toBe("Ada Lovelace");
      expect(valueOf(start, "textbox", "Draft")).toBe("Reference 4821-amber\nsecond line");
      expect(valueOf(start, "searchbox", "Search")).toBe("norway fjords");
      expect(JSON.stringify(start)).not.toContain("hunter22-secret");
      expect(valueOf(start, "textbox", "Password")).toEqual({ redacted: true, reason: "password" });

      const raw = ["{{", "secret:Service/api key", "}}"].join("");
      const secret = "sk-live-0123456789abcdef";
      const typed = await driver.dispatch({
        ...command(start, {
          type: "fill",
          locator: { kind: "label", text: "API key" },
          value: raw,
        }),
        secretValues: { [referenceKey(parseSecretReference(raw))]: secret },
      } as BrowserActionCommand);
      // The reference resolves where the fill runs. An ordinary field is not
      // a protected field: it, its page echo and the title show what it holds.
      expect(valueOf(typed, "textbox", "API key")).toBe(secret);
      const later = await driver.observe(start.target.id);
      expect(valueOf(later, "textbox", "API key")).toBe(secret);
      expect(valueOf(later, "textbox", "Name")).toBe("Ada Lovelace");
      expect(JSON.stringify(later)).not.toContain("hunter22-secret");
      const read = await driver.readDom(start.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#echo" },
        expectedTargetGeneration: later.target.targetGeneration,
        expectedDocumentGeneration: later.target.documentGeneration!,
        expectedFrameId: later.frameId!,
      });
      expect(read.text).toBe(`Key ends ${secret}`);
      const tabs = await driver.listTargets();
      expect(tabs.find((tab) => tab.id === start.target.id)?.title).toBe(`Key ${secret}`);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

function valueOf(observation: BrowserObservation, role: string, name: string): unknown {
  const node = nodes(observation).find(
    (candidate) => candidate.role.toLowerCase() === role && candidate.name === name,
  );
  if (!node) throw new Error(`missing ${role} ${name}`);
  return node.value;
}

function nodes(observation: BrowserObservation): InteractionSemanticNodeValue[] {
  if (observation.semantic?.kind !== "snapshot") return [];
  const flattened: InteractionSemanticNodeValue[] = [];
  const visit = (node: InteractionSemanticNodeValue) => {
    flattened.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of observation.semantic.roots) visit(root);
  return flattened;
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
    actor: { kind: "agent", subjectId: "browserd-field-values-e2e" },
    action,
  };
}
