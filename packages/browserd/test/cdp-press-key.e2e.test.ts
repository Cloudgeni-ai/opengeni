import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "unsupported keys and unfocusable locators are refused before any input",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-press-key-");
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
    let cdp: CdpConnection | null = null;
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Press proof</title><input aria-label="Text"><button>Card</button><script>globalThis.keys=[];document.addEventListener("keydown",e=>keys.push(e.key));document.querySelector("input").focus();</script>',
    )}`;
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
      actor: { kind: "human", subjectId: "press-key-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(fixture);
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
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      const activeTag = () => evaluate("document.activeElement?.tagName ?? null");
      expect(await activeTag()).toBe("INPUT");

      const button = { kind: "role", role: "button", name: "Card", exact: true } as const;
      for (const key of ["Shift", "Mod", "Ctrl+F25", "Ctrl+Hyper+A", "NotAKey"]) {
        const refused = await controller.run(
          command(initial, { type: "press", locator: button, key }),
        );
        expect(refused.state).toBe("failed");
        expect(refused.error?.code).toBe("invalid_action");
        // No focus moved and no key reached the page.
        expect(await activeTag()).toBe("INPUT");
        expect(await evaluate("keys.length")).toBe(0);
      }

      const accepted = await controller.run(
        command(initial, { type: "press", locator: button, key: "Escape" }),
      );
      expect(accepted.state).toBe("completed");
      expect(await activeTag()).toBe("BUTTON");
      expect(await evaluate("keys")).toEqual(["Escape"]);

      // Function and navigation keys reach the page with their standard
      // names, including the common short spellings. A modifier goes down as
      // its own key first, as a person presses it.
      await evaluate(
        'globalThis.codes=[];document.addEventListener("keydown",e=>codes.push([e.key,e.code,e.keyCode,e.ctrlKey]))',
      );
      for (const key of ["F2", "f12", "Home", "End", "PageUp", "pgdn", "Insert", "Ctrl+F5"]) {
        const pressed = await controller.run(
          command(initial, { type: "press", locator: button, key }),
        );
        expect(pressed.state).toBe("completed");
      }
      expect(await evaluate("codes")).toEqual([
        ["F2", "F2", 113, false],
        ["F12", "F12", 123, false],
        ["Home", "Home", 36, false],
        ["End", "End", 35, false],
        ["PageUp", "PageUp", 33, false],
        ["PageDown", "PageDown", 34, false],
        ["Insert", "Insert", 45, false],
        ["Control", "ControlLeft", 17, true],
        ["F5", "F5", 116, true],
      ]);
      await evaluate("globalThis.keys=['Escape']");

      // The document node is focusable in the accessibility snapshot but is
      // not an Element, so Chromium refuses DOM.focus. That refusal must be a
      // definite invalid_action with no key sent, not an unknown outcome.
      const view = await driver.observe(initial.target.id);
      const queue = view.semantic?.kind === "snapshot" ? [...view.semantic.roots] : [];
      let documentRef: string | undefined;
      while (queue.length && !documentRef) {
        const node = queue.pop()!;
        if (node.role === "document" || node.role === "RootWebArea") documentRef = node.ref;
        if (node.children) queue.push(...node.children);
      }
      expect(documentRef).toBeDefined();
      const refusedFocus = await controller.run(
        command(view, {
          type: "press",
          locator: { kind: "ref", ref: documentRef! },
          key: "Escape",
        }),
      );
      expect(refusedFocus.state).toBe("failed");
      expect(refusedFocus.error?.code).toBe("invalid_action");
      expect(await activeTag()).toBe("BUTTON");
      expect(await evaluate("keys")).toEqual(["Escape"]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

e2e(
  "typed keys follow a code field that moves focus a frame later",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-code-boxes-");
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
    let cdp: CdpConnection | null = null;
    // Nine one-character boxes. Like a React effect, the page moves focus to
    // the next box in a task after the next frame, not inside the key event.
    const boxes = Array.from(
      { length: 9 },
      (_, i) => `<input maxlength="1" aria-label="Code character ${i + 1} of 9">`,
    ).join("");
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Code boxes</title>${boxes}<script>const all=[...document.querySelectorAll("input")];all.forEach((box,i)=>box.addEventListener("input",()=>{box.value=box.value.slice(-1);if(box.value&&all[i+1])requestAnimationFrame(()=>setTimeout(()=>all[i+1].focus(),0));}));</script>`,
    )}`;
    try {
      const initial = await driver.start(fixture);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const typed = await controller.run({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: initial.target.id,
        expectedTargetGeneration: initial.target.targetGeneration,
        expectedDocumentGeneration: initial.target.documentGeneration!,
        expectedFrameId: initial.frameId!,
        actor: { kind: "human", subjectId: "code-boxes-fixture" },
        observationMode: "none",
        action: {
          type: "type",
          locator: { kind: "label", text: "Code character 1 of 9" },
          text: "BIJJL4Q4J",
          mode: "keys",
        },
      });
      expect(typed.state).toBe("completed");
      const value = (
        await cdp.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          {
            expression: '[...document.querySelectorAll("input")].map((box) => box.value).join("")',
            returnByValue: true,
          },
          { sessionId: attached.sessionId },
        )
      ).result.value;
      expect(value).toBe("BIJJL4Q4J");
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

e2e(
  "typed keys reach a canvas that reads physical keys, and inserted text is not lost on it",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-canvas-keys-");
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
    let cdp: CdpConnection | null = null;
    // Like a remote-desktop viewer that forwards scancodes: the canvas reads
    // only which physical key went down and whether a Shift key is held, and
    // the remote side turns that into a character on a US layout.
    const script = `
      const plain = "1234567890-=[]\\\\;',./\`";
      const shifted = '!@#$%^&*()_+{}|:"<>?~';
      const codes = ["Digit1","Digit2","Digit3","Digit4","Digit5","Digit6","Digit7","Digit8","Digit9","Digit0","Minus","Equal","BracketLeft","BracketRight","Backslash","Semicolon","Quote","Comma","Period","Slash","Backquote"];
      const screen = document.querySelector("canvas");
      globalThis.remote = ""; globalThis.downs = [];
      let shift = false;
      screen.addEventListener("keyup", (e) => { if (e.code.startsWith("Shift")) shift = false; e.preventDefault(); });
      screen.addEventListener("keydown", (e) => {
        e.preventDefault();
        downs.push(e.code);
        if (e.code.startsWith("Shift")) { shift = true; return; }
        if (e.code.startsWith("Key")) { const letter = e.code.slice(3); remote += shift ? letter : letter.toLowerCase(); return; }
        if (e.code === "Space") { remote += " "; return; }
        const index = codes.indexOf(e.code);
        if (index >= 0) remote += (shift ? shifted : plain)[index];
      });
      screen.focus();`;
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Remote screen</title><canvas tabindex="0" width="320" height="200" aria-label="Remote screen"></canvas><input aria-label="Note"><script>${script}</script>`,
    )}`;
    try {
      const initial = await driver.start(fixture);
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
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      const run = (action: BrowserActionCommand["action"]) =>
        controller.run({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: initial.target.id,
          expectedTargetGeneration: initial.target.targetGeneration,
          expectedDocumentGeneration: initial.target.documentGeneration!,
          expectedFrameId: initial.frameId!,
          actor: { kind: "human", subjectId: "canvas-keys-fixture" },
          observationMode: "none",
          action,
        });
      expect(await evaluate("document.activeElement?.tagName")).toBe("CANVAS");

      // Uppercase letters and shifted symbols need Shift held on their key.
      const text = `Hello World 1! aB@#$%^&*()_+{}|:"<>?~ -=[]\\;',./\``;
      const typed = await run({ type: "type", text, mode: "keys" });
      expect(typed.state).toBe("completed");
      expect(await evaluate("remote")).toBe(text);

      // A key combination presses its modifier first.
      await evaluate("downs.length = 0");
      expect((await run({ type: "press", key: "Ctrl+A" })).state).toBe("completed");
      expect(await evaluate("downs")).toEqual(["ControlLeft", "KeyA"]);

      // Inserted text has nowhere to go on a canvas: refuse it rather than
      // report text that never arrived.
      await evaluate('remote = ""; downs.length = 0');
      const inserted = await run({ type: "type", text: "lost" });
      expect(inserted.state).toBe("failed");
      expect(inserted.error?.code).toBe("invalid_action");
      expect(inserted.error?.message).toContain("mode:'keys'");
      expect(await evaluate("downs.length")).toBe(0);

      // A text field still takes inserted text.
      const field = await run({
        type: "type",
        locator: { kind: "label", text: "Note" },
        text: "Inserted Text!",
      });
      expect(field.state).toBe("completed");
      expect(await evaluate('document.querySelector("input").value')).toBe("Inserted Text!");
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

e2e(
  "typing reaches code editors, refuses a non-text target before focusing it, reports text-only characters a canvas may miss, and never leaves a modifier held",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-canvas-edge-");
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
    let cdp: CdpConnection | null = null;
    // A canvas that reads physical keys and Shift (a remote desktop), an
    // EditContext editor (how Monaco and VS Code for the web take text), a
    // button and a text field.
    const script = `
      const screen = document.querySelector("canvas");
      globalThis.remote = ""; globalThis.held = new Set();
      screen.addEventListener("keyup", (e) => { held.delete(e.code); e.preventDefault(); });
      screen.addEventListener("keydown", (e) => {
        e.preventDefault();
        held.add(e.code);
        const shift = held.has("ShiftLeft");
        if (e.code.startsWith("Key")) remote += shift ? e.code.slice(3) : e.code.slice(3).toLowerCase();
        else if (e.code === "Digit1") remote += shift ? "!" : "1";
      });
      const editor = document.querySelector("#editor");
      globalThis.context = new EditContext();
      editor.editContext = context;
      context.addEventListener("textupdate", (e) => context.updateSelection(e.selectionEnd, e.selectionEnd));
      editor.focus();`;
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Edges</title><canvas tabindex="0" width="200" height="100" aria-label="Remote screen"></canvas><div id="editor" tabindex="0" aria-label="Code"></div><button>Save</button><input aria-label="Note"><script>${script}</script>`,
    )}`;
    try {
      const initial = await driver.start(fixture);
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
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      const run = (action: BrowserActionCommand["action"]) =>
        controller.run({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: initial.target.id,
          expectedTargetGeneration: initial.target.targetGeneration,
          expectedDocumentGeneration: initial.target.documentGeneration!,
          expectedFrameId: initial.frameId!,
          actor: { kind: "human", subjectId: "canvas-edge-fixture" },
          observationMode: "none",
          action,
        });

      // An EditContext editor takes inserted text.
      expect(await evaluate("document.activeElement.id")).toBe("editor");
      const edited = await run({ type: "type", text: "const x = 1;" });
      expect(edited.state).toBe("completed");
      expect(await evaluate("context.text")).toBe("const x = 1;");

      // A locator that names a button is refused before focus moves, as a
      // definite failure rather than an unknown outcome.
      const refused = await run({
        type: "type",
        locator: { kind: "role", role: "button", name: "Save", exact: true },
        text: "lost",
      });
      expect(refused.state).toBe("failed");
      expect(refused.error?.code).toBe("invalid_action");
      expect(await evaluate("document.activeElement.id")).toBe("editor");

      // A character with no US key reaches a text field as text...
      const field = await run({
        type: "type",
        locator: { kind: "label", text: "Note" },
        text: "blåbær",
        mode: "keys",
      });
      expect(field.state).toBe("completed");
      expect(await evaluate('document.querySelector("input").value')).toBe("blåbær");
      // ...but a canvas reading physical keys gets nothing for it, so the
      // result names it instead of reporting the text as typed.
      await evaluate('document.querySelector("canvas").focus()');
      const canvas = await run({ type: "type", text: "blåbær", mode: "keys" });
      expect(canvas.state).not.toBe("completed");
      expect(canvas.error?.code).toBe("outcome_unknown");
      expect(canvas.error?.message).toContain('"å", "æ"');
      expect(await evaluate("remote")).toBe("blbr");

      // A pressed symbol is its US key with Shift held.
      await evaluate('remote = ""');
      expect((await run({ type: "press", key: "!" })).state).toBe("completed");
      expect(await evaluate("remote")).toBe("!");

      // A key that fails to send still releases the modifiers pressed for it.
      const internals = driver as unknown as {
        sendActionTarget: (state: unknown, method: string, params?: unknown) => Promise<unknown>;
      };
      const send = internals.sendActionTarget.bind(driver);
      internals.sendActionTarget = async (state, method, params) => {
        const event = params as { type?: string; code?: string } | undefined;
        if (
          method === "Input.dispatchKeyEvent" &&
          event?.type === "keyDown" &&
          event.code === "KeyV"
        )
          throw new Error("injected key failure");
        return send(state, method, params);
      };
      const failed = await run({ type: "press", key: "Ctrl+Shift+V" });
      internals.sendActionTarget = send;
      expect(failed.state).not.toBe("completed");
      expect(await evaluate("[...held]")).toEqual([]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
