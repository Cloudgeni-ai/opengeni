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

/** Fields a copy must not take, text around a character outside the basic
 * plane, and text larger than the clipboard. */
const GUARDED = `<!doctype html><meta charset="utf-8"><title>Guarded</title><main><label>Card <input name="card-number" value="4111111111111111"></label><label>Code <input autocomplete="one-time-code" value="123456"></label><div role="group" aria-label="Billing"><p>Billing details</p><input type="hidden" name="token" value="t0k3n"></div><div role="group" aria-label="Notes"><p id="note">Visible note</p><input type="hidden" name="token" value="t0k3n"></div><div role="group" aria-label="Account" id="account"><p>Account holder</p><p data-private>Private detail</p></div><label>Emoji <textarea id="emoji"></textarea></label><div id="big" aria-hidden="true"></div><button onclick="getSelection().selectAllChildren(note)">Select note</button><button onclick="getSelection().selectAllChildren(account)">Select account</button></main><script>emoji.value = "a".repeat(1999) + "\u{1F600}" + "b".repeat(10); big.textContent = "x".repeat(1_100_000);</script>`;

e2e(
  "copy withholds what DOM reads withhold, pages keep characters whole, and oversized copies say how to read",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-guarded-text-");
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
      const observation = await driver.start(`data:text/html,${encodeURIComponent(GUARDED)}`);
      const act = async (action: BrowserActionCommand["action"]) =>
        await controller.run({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: observation.target.id,
          expectedTargetGeneration: observation.target.targetGeneration,
          expectedDocumentGeneration: observation.target.documentGeneration!,
          expectedFrameId: observation.frameId!,
          actor: { kind: "human", subjectId: "guarded-text-fixture" },
          observationMode: "none",
          action,
        });
      const copy = async (locator: unknown, content?: "selection" | "value" | "text") =>
        await act({
          type: "clipboard",
          operation: "copy",
          locator,
          ...(content ? { content } : {}),
        } as never);
      const label = (text: string) => ({ kind: "label" as const, text });
      const group = (name: string) => ({ kind: "role" as const, role: "group", name, exact: true });

      // Payment and one-time-code fields are withheld whichever way they are copied.
      for (const field of ["Card", "Code"]) {
        for (const content of [undefined, "value", "text", "selection"] as const) {
          const result = await copy(label(field), content);
          expect(result.error?.code).toBe("permission_denied");
        }
      }
      // So is a container holding a hidden or private field.
      expect((await copy(group("Billing"))).error?.code).toBe("permission_denied");
      expect((await copy(group("Account"), "text")).error?.code).toBe("permission_denied");
      // A selection counts only the fields it touches.
      expect(
        (
          await act({
            type: "click",
            locator: { kind: "role", role: "button", name: "Select note" },
          })
        ).error ?? null,
      ).toBeNull();
      const note = await copy(group("Notes"), "selection");
      expect(note.error ?? null).toBeNull();
      expect(driver.readClipboard().text).toBe("Visible note");
      await act({
        type: "click",
        locator: { kind: "role", role: "button", name: "Select account" },
      });
      expect((await copy(group("Account"), "selection")).error?.code).toBe("permission_denied");
      expect(driver.readClipboard().text).toBe("Visible note");

      // A page boundary never splits a character in two.
      const fences = {
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
      };
      const page = async (offset: number) =>
        await driver.readDom(observation.target.id, {
          ...fences,
          kind: "element",
          locator: { kind: "css", selector: "#emoji" },
          maxChars: 2_000,
          offset,
        });
      const first = await page(0);
      expect(first.truncated).toBe(true);
      expect(first.value).toBe("a".repeat(1999));
      const second = await page(first.value!.length);
      expect(second.value).toBe("\u{1F600}" + "b".repeat(10));
      expect(second.truncated).toBe(false);

      // A copy larger than the clipboard says how to read it instead.
      const big = await copy({ kind: "css", selector: "#big" }, "text");
      expect(big.error?.code).toBe("invalid_action");
      expect(big.error?.message).toContain("browser_read mode=dom and offset");
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
