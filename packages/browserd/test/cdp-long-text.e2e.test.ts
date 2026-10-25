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

const LONG = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");

/** Long read-only text in the shapes pages use: a native text area, a custom
 * text box (a div with role=textbox, as code and rich-text editors render),
 * and plain preformatted text. */
const PAGE = `<!doctype html><title>Notes</title><main><h1>Notes</h1><label>Template <textarea readonly rows=4 cols=60>${LONG}</textarea></label><div role="textbox" aria-readonly="true" aria-multiline="true" aria-label="Policy" tabindex="0">${LONG}</div><pre aria-label="Log">${LONG}</pre><label>Secret <input type="password" value="hunter2"></label></main>`;

function nodes(observation: BrowserObservation): InteractionSemanticNodeValue[] {
  const semantic = observation.semantic;
  const pending = semantic?.kind === "snapshot" ? [...semantic.roots] : [];
  const found: InteractionSemanticNodeValue[] = [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    found.push(node);
    if (node.children) pending.unshift(...node.children);
  }
  return found;
}

e2e(
  "long read-only text copies to the clipboard and reads in full in pages",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-long-text-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
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
    try {
      const observation = await driver.start(`data:text/html,${encodeURIComponent(PAGE)}`);
      const copy = async (action: Omit<BrowserActionCommand["action"] & object, "type">) =>
        await controller.run({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: observation.target.id,
          expectedTargetGeneration: observation.target.targetGeneration,
          expectedDocumentGeneration: observation.target.documentGeneration!,
          expectedFrameId: observation.frameId!,
          actor: { kind: "human", subjectId: "long-text-fixture" },
          observationMode: "none",
          action: { type: "clipboard", operation: "copy", ...action } as never,
        });
      const ref = (name: string) =>
        nodes(observation).find(
          (node) => node.name === name && !["text", "StaticText", "LabelText"].includes(node.role),
        )!.ref;

      // Copying an element without saying what copies all of what it shows.
      for (const name of ["Template", "Policy", "Log"]) {
        const result = await copy({ locator: { kind: "ref", ref: ref(name) } });
        expect(result.error ?? null).toBeNull();
        expect(driver.readClipboard().text?.trim()).toBe(LONG);
      }
      // A custom text box has a value: its text.
      const custom = await copy({ locator: { kind: "ref", ref: ref("Policy") }, content: "value" });
      expect(custom.error ?? null).toBeNull();
      expect(driver.readClipboard().text?.trim()).toBe(LONG);
      // A text area's text is its value.
      const area = await copy({ locator: { kind: "ref", ref: ref("Template") }, content: "text" });
      expect(area.error ?? null).toBeNull();
      expect(driver.readClipboard().text).toBe(LONG);

      // Failures say why and what to do instead.
      const noValue = await copy({ locator: { kind: "ref", ref: ref("Log") }, content: "value" });
      expect(noValue.error?.code).toBe("invalid_action");
      expect(noValue.error?.message).toContain('content "text"');
      const noSelection = await copy({
        locator: { kind: "ref", ref: ref("Log") },
        content: "selection",
      });
      expect(noSelection.error?.message).toContain("nothing selected in this element");
      const secret = await copy({ locator: { kind: "ref", ref: ref("Secret") } });
      expect(secret.error?.code).toBe("permission_denied");

      // A DOM read pages through the whole value with offset.
      const fences = {
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
      };
      let read = "";
      for (let offset = 0, pages = 0; pages < 10; pages += 1) {
        const page = await driver.readDom(observation.target.id, {
          ...fences,
          kind: "element",
          locator: { kind: "ref", ref: ref("Template") },
          maxChars: 2_000,
          offset,
        });
        read += page.value ?? "";
        if (!page.truncated) break;
        offset += page.value!.length;
      }
      expect(read).toBe(LONG);

      // The ref on a clipped text line reads that text in full.
      const line = nodes(observation).find(
        (node) => node.role !== "textbox" && node.name?.startsWith("word0 ") === true,
      )!;
      const whole = await driver.readDom(observation.target.id, {
        ...fences,
        kind: "element",
        locator: { kind: "ref", ref: line.ref },
        maxChars: 32_768,
      });
      expect(whole.text?.trim()).toBe(LONG);
      expect(whole.truncated).toBe(false);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
