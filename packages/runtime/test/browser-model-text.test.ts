import { describe, expect, test } from "bun:test";

import {
  browserActionText,
  browserNodeLine,
  browserObservationDiff,
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

  test("a scrolling panel shows its ref and the directions it can scroll", () => {
    const observation = formObservation();
    observation.agentView = {
      sourceKind: "snapshot",
      nodes: [
        {
          ref: "e00000011",
          role: "generic",
          depth: 0,
          states: ["focusable", "scrollable=up,down"],
          actions: ["scroll"],
        },
      ],
    };
    expect(browserObservationText(observation)).toContain(
      "- generic [e00000011] scrollable=up,down",
    );
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
        "Changed elements since your last reading of this page; elements not listed are unchanged and keep their refs:",
        '- textbox "Password" [e0000000c] value=<redacted>',
        "(1 element from your last reading is gone or no longer listed; 3 long fields clipped)",
      ].join("\n"),
    );
  });

  test("clips a long form field value and says how long it is", () => {
    const value = `${"word ".repeat(600)}end`;
    const line = browserNodeLine(
      { ref: "e0000000c", role: "textbox", depth: 0, name: "Body", value },
      false,
    );
    expect(line).toBe(
      `- textbox "Body" [e0000000c] value=${JSON.stringify(`${value.slice(0, 2_000)}…`)} valueChars=${value.length}`,
    );
  });

  test("a clipped name, value or text keeps its ref, its full length and the way to read it", () => {
    const text = browserObservationText({
      target,
      agentView: {
        sourceKind: "snapshot",
        nodes: [
          {
            ref: "e0000000c",
            role: "textbox",
            depth: 0,
            name: "Policy",
            value: `${"a".repeat(179)}…`,
            valueChars: 3_299,
            states: ["readonly"],
          },
          {
            ref: "e0000000d",
            role: "text",
            depth: 0,
            name: `${"b".repeat(179)}…`,
            nameChars: 1_240,
          },
          { ref: "e0000000e", role: "text", depth: 0, name: "Short" },
        ],
        clippedFieldCount: 2,
      },
    });
    expect(text.split("\n").slice(1)).toEqual([
      `- textbox "Policy" [e0000000c] value=${JSON.stringify(`${"a".repeat(179)}…`)} valueChars=3299 readonly`,
      `- text ${JSON.stringify(`${"b".repeat(179)}…`)} nameChars=1240 [e0000000d]`,
      '- text "Short"',
      "(2 long fields clipped; browser_read mode=dom with an element's ref reads it in full)",
    ]);
  });

  test("says when no accessibility view is available", () => {
    expect(
      browserObservationText({ target, agentView: { sourceKind: "none", nodes: [] } }),
    ).toContain("No accessibility view is available for this tab.");
  });

  test("says when a page was too large to read whole, only then", () => {
    const nodes = [{ ref: "e00000010", role: "button", depth: 0, name: "Create" }];
    const partial = browserObservationText({
      target,
      agentView: { sourceKind: "snapshot", nodes, unreadNodeCount: 5_900 },
    });
    expect(partial.split("\n").at(-1)).toBe(
      "Partial outline: the page is too large to read whole, and at least 5900 elements were not read. It lists the page's structure and the part on screen; scroll to bring other parts into it.",
    );
    expect(
      browserObservationText({ target, agentView: { sourceKind: "snapshot", nodes } }),
    ).not.toContain("Partial outline");
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

  test("an action receipt passes on what its actions noted, such as a network that stayed busy", () => {
    const text = browserActionText({
      targetId: "T1",
      state: "completed",
      error: null,
      notes: [
        {
          message:
            "page loaded; its network was still busy after 30 s (it kept requests open or kept starting new ones, as pages that poll continuously do), so the wait ended there",
        },
      ],
      observation: formObservation(),
    });
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Action completed on tab T1.",
      "Note: page loaded; its network was still busy after 30 s (it kept requests open or kept starting new ones, as pages that poll continuously do), so the wait ended there.",
      'Tab T1: "Checkout" https://shop.example/checkout',
    ]);
  });

  test("an opened Chrome profile names the computer it is on", () => {
    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      lifecycle: "active",
      placement: { kind: "attached_device" },
      engine: "chromium",
    };
    const chosen = "22222222-2222-4222-8222-222222222222";
    const other = "33333333-3333-4333-8333-333333333333";
    const unknown = "44444444-4444-4444-8444-444444444444";
    expect(
      browserOpenText({
        session,
        targets: [],
        attachedProfile: {
          id: chosen,
          name: "Person 1",
          profileLabel: "ada@example.com",
          machine: "Ada's Mac mini",
          onThisMachine: true,
        },
        otherAttachedProfiles: [
          { id: other, name: "Work", machine: "Ada's MacBook Pro" },
          { id: unknown, name: "Old" },
        ],
      }).split("\n"),
    ).toEqual([
      `BrowserSession ${session.id} (active): chromium on the user's own Chrome`,
      `Attached Chrome profile: "Person 1" (ada@example.com) on "Ada's Mac mini" (this session's machine) deviceId ${chosen}`,
      `Other attached profiles: "Work" on "Ada's MacBook Pro" deviceId ${other}; "Old" deviceId ${unknown}`,
      "No tabs are open.",
    ]);
    // A profile on another computer says which, with no marker.
    expect(
      browserOpenText({
        session,
        targets: [],
        attachedProfile: { id: other, name: "Work", machine: "Ada's MacBook Pro" },
      }).split("\n")[1],
    ).toBe(`Attached Chrome profile: "Work" on "Ada's MacBook Pro" deviceId ${other}`);
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
    // A launch notice follows the session line, once, on the opening call.
    expect(
      browserOpenText({
        session,
        targets: [],
        notice: "This browser uses the machine's network directly.",
      }),
    ).toBe(
      "BrowserSession 11111111-1111-4111-8111-111111111111 (ready): chromium headless on a Connected Machine\nThis browser uses the machine's network directly.\nNo tabs are open.",
    );
    // A headed browser is reported as its controller launched it: one shown
    // offscreen says it has no window, one in a window (or from a controller
    // that does not report it) keeps the plain headed line.
    const headed = { ...session, headless: false };
    expect(browserOpenText({ session: { ...headed, display: "offscreen" }, targets: [] })).toBe(
      "BrowserSession 11111111-1111-4111-8111-111111111111 (ready): chromium headed, offscreen with no window, on a Connected Machine\nNo tabs are open.",
    );
    expect(browserOpenText({ session: { ...headed, display: "window" }, targets: [] })).toBe(
      "BrowserSession 11111111-1111-4111-8111-111111111111 (ready): chromium headed on a Connected Machine\nNo tabs are open.",
    );
    expect(browserOpenText({ session: headed, targets: [] })).toBe(
      "BrowserSession 11111111-1111-4111-8111-111111111111 (ready): chromium headed on a Connected Machine\nNo tabs are open.",
    );
    expect(browserTabsText({ browserSessionId: session.id, targets: [target] })).toBe(
      `BrowserSession ${session.id} has 1 tab:\nTab T1 selected: "Checkout" https://shop.example/checkout`,
    );
    // The observed tab is listed once, by the observation that follows.
    const tabsWithOutline = browserTabsText({
      browserSessionId: session.id,
      targets: [target, { ...target, id: "T2", title: "Other", selected: false }],
      mutationObservation: formObservation(),
    });
    expect(tabsWithOutline.split("\n").slice(0, 3)).toEqual([
      `BrowserSession ${session.id} has 2 tabs:`,
      'Tab T2: "Other" https://shop.example/checkout',
      'Tab T1: "Checkout" https://shop.example/checkout',
    ]);
    expect(tabsWithOutline.match(/Tab T1\b/g)).toHaveLength(1);
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

  test("a page diff falls back to the whole outline when it would not help or could mislead", () => {
    const node = (ref: string, value = "") => ({
      ref,
      role: "textbox",
      depth: 2,
      name: ref,
      ...(value ? { value } : {}),
    });
    const page = (nodes: ReturnType<typeof node>[], documentGeneration = "d1") => ({
      target: { ...target, documentGeneration },
      agentView: { sourceKind: "snapshot", nodes, omittedNodeCount: 40 },
    });
    const base = page([node("e1"), node("e2"), node("e3"), node("e4")]);
    const diff = browserObservationDiff(base, page([node("e1", "x"), node("e2"), node("e3")]));
    expect(diff?.agentView).toEqual({
      sourceKind: "diff",
      nodes: [{ ...node("e1", "x"), depth: 0 }],
      omittedNodeCount: 40,
      removedRefCount: 1,
    });
    // The page's other elements are not news to the model.
    expect(browserObservationText(diff!)).not.toContain("not shown");
    // Another document, most of the page changed, or no outline: the whole outline.
    expect(browserObservationDiff(base, page(base.agentView.nodes, "d2"))).toBeNull();
    expect(
      browserObservationDiff(base, page([node("e1", "a"), node("e2", "b"), node("e5")])),
    ).toBeNull();
    expect(
      browserObservationDiff(base, { ...page([]), agentView: { sourceKind: "none", nodes: [] } }),
    ).toBeNull();
  });
});
