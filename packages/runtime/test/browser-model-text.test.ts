import { describe, expect, test } from "bun:test";

import {
  browserActionText,
  browserObservationText,
  browserOpenText,
  browserReadText,
  browserTabsText,
  type BrowserTextObservation,
} from "../src/browser-model-text";

const target = {
  id: "T1",
  kind: "page",
  title: "Checkout",
  url: "https://shop.example/checkout",
  selected: true,
};

function formObservation(): BrowserTextObservation {
  return {
    target,
    viewport: { width: 1280, height: 720 },
    agentView: {
      sourceKind: "snapshot",
      nodes: [
        { ref: "e0000000a", role: "document", depth: 2, name: "Checkout", states: ["focused"] },
        { ref: "e0000000b", role: "heading", depth: 3, name: "Delivery", states: ["level=2"] },
        {
          ref: "e0000000c",
          role: "textbox",
          depth: 3,
          name: "Full name",
          value: "Ada",
          states: ["focusable", "editable=plaintext", "settable", "required"],
        },
        {
          ref: "e0000000d",
          role: "combobox",
          depth: 3,
          name: "Country",
          states: ["focusable", "expanded=false"],
        },
        { ref: "e0000000e", role: "text", depth: 4, name: "Free shipping" },
        { ref: "e0000000f", role: "button", depth: 3, name: "Place order", states: ["focusable"] },
      ],
      omittedNodeCount: 12,
    },
  };
}

describe("browser model text", () => {
  test("renders a compact page outline with refs only on actionable elements", () => {
    expect(browserObservationText(formObservation())).toBe(
      [
        'Tab T1: "Checkout" https://shop.example/checkout',
        "Viewport 1280x720",
        '- document "Checkout"',
        '  - heading "Delivery" level=2',
        '  - textbox "Full name" [e0000000c] value="Ada" required',
        '  - combobox "Country" [e0000000d] expanded=false',
        '    - text "Free shipping"',
        '  - button "Place order" [e0000000f]',
        "(12 elements not shown)",
      ].join("\n"),
    );
  });

  test("a complete view lists every ref", () => {
    const text = browserObservationText(formObservation(), { allRefs: true });
    expect(text).toContain('- document "Checkout" [e0000000a]');
    expect(text).toContain('    - text "Free shipping" [e0000000e]');
  });

  test("a text node that reports actions keeps its ref", () => {
    const observation = formObservation();
    observation.agentView = {
      sourceKind: "snapshot",
      nodes: [{ ref: "e00000010", role: "generic", depth: 0, name: "Menu", actions: ["click"] }],
    };
    expect(browserObservationText(observation)).toContain('- generic "Menu" [e00000010]');
  });

  test("reports dialogs, diagnostics, diffs, redaction and removals", () => {
    const text = browserObservationText({
      target: { ...target, kind: "popup" },
      dialog: { type: "prompt", message: "Your name?", defaultPrompt: "Guest" },
      diagnostics: {
        consoleErrorCount: 2,
        failedRequestCount: 1,
        downloadCount: 0,
        pageErrorCount: 0,
      },
      focusedRef: "e0000000c",
      agentView: {
        sourceKind: "diff",
        nodes: [
          {
            ref: "e0000000c",
            role: "textbox",
            depth: 5,
            name: "Password",
            value: { redacted: true, reason: "password" },
          },
        ],
        removedRefCount: 1,
        clippedFieldCount: 3,
      },
    });
    expect(text).toBe(
      [
        'Tab T1 (popup): "Checkout" https://shop.example/checkout',
        'Open prompt dialog: "Your name?" default "Guest"',
        "Page reported 2 console errors, 1 failed request",
        "Focused element: e0000000c",
        "Changed elements:",
        '- textbox "Password" [e0000000c] value=<redacted>',
        "(1 earlier element removed; 3 long fields clipped)",
      ].join("\n"),
    );
  });

  test("says when no accessibility view is available", () => {
    expect(
      browserObservationText({ target, agentView: { sourceKind: "none", nodes: [] } }),
    ).toContain("No accessibility view is available for this tab.");
  });

  test("an action receipt names the outcome, the resolved elements and the page after", () => {
    const text = browserActionText({
      targetId: "T1",
      state: "failed",
      error: {
        code: "locator_not_found",
        message: "No element matched.",
        retryable: true,
        candidates: 0,
      },
      targets: [
        {
          actionIndex: 0,
          ref: "e0000000f",
          role: "button",
          name: "Place order",
          container: { role: "form", name: "Delivery" },
        },
      ],
      observation: formObservation(),
    });
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Action failed on tab T1.",
      'Error locator_not_found (retryable): No element matched. {"candidates":0}',
      'Acted on: #0 button "Place order" [e0000000f] in form "Delivery"',
      'Tab T1: "Checkout" https://shop.example/checkout',
    ]);
  });

  test("open, tabs and read views", () => {
    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      lifecycle: "ready",
      placement: { kind: "connected_machine" },
      engine: "chromium",
      headless: true,
    };
    const opened = browserOpenText({
      session,
      targets: [target, { ...target, id: "T2", title: "Other", selected: false }],
      otherTabCount: 3,
      observation: formObservation(),
    });
    expect(opened.split("\n").slice(0, 4)).toEqual([
      "BrowserSession 11111111-1111-4111-8111-111111111111 (ready): chromium headless on a Connected Machine",
      'Tab T2: "Other" https://shop.example/checkout',
      "3 other tabs (browser_tabs list shows them)",
      'Tab T1: "Checkout" https://shop.example/checkout',
    ]);
    expect(
      browserOpenText({
        session: { ...session, placement: { kind: "attached_device" } },
        targets: [],
      }),
    ).toBe(
      "BrowserSession 11111111-1111-4111-8111-111111111111 (ready): chromium on the user's own Chrome\nNo tabs are open.",
    );
    expect(browserTabsText({ browserSessionId: session.id, targets: [target] })).toBe(
      `BrowserSession ${session.id} has 1 tab:\nTab T1 selected: "Checkout" https://shop.example/checkout`,
    );
    expect(
      browserReadText({
        targetId: "T1",
        mode: "accessibility",
        scopeFound: true,
        nodes: [{ ref: "e0000000e", role: "text", depth: 7, name: "Free shipping" }],
        totalMatches: 2,
        omittedMatches: 1,
        clippedFieldCount: 0,
      }),
    ).toBe(
      'Tab T1: 2 matches (accessibility)\n- text "Free shipping" [e0000000e]\n(1 match not shown)',
    );
  });
});
