import { describe, expect, test } from "bun:test";
import {
  computerActionText,
  computerObservationText,
  computerOpenText,
  type ComputerTextNode,
  type ComputerTextObservation,
} from "../src/computer-model-text";

const shown = ["enabled", "sensitive", "showing", "visible"];
const common = ["focus", "invoke", "scroll_into_view"];

function node(
  ref: string,
  role: string,
  name: string | undefined,
  extra: Partial<ComputerTextNode> = {},
): ComputerTextNode {
  return {
    ref,
    role,
    ...(name === undefined ? {} : { name }),
    states: shown,
    actions: common,
    ...extra,
  };
}

function observation(
  semantic: ComputerTextObservation["semantic"],
  focusedRef: string | null = null,
): ComputerTextObservation {
  return {
    observationId: "o_1",
    target: {
      id: "window:1",
      kind: "window",
      title: "Sign in - Chromium",
      processId: 42,
      bounds: { x: 9, y: 9, width: 1052, height: 842 },
      focused: true,
      targetGeneration: "g_1",
    },
    frameId: "f_1",
    capturedFrame: { width: 960, height: 768 },
    semantic,
    focusedRef,
    changedRegions: [],
  };
}

describe("computerObservationText", () => {
  test("lists what an AT-SPI window shows and leaves out platform noise", () => {
    const roots = [
      node("e_frame", "frame", "Sign in - Chromium", {
        states: [...shown, "active"],
        children: [
          node("e_panel", "panel", "panel", {
            children: [
              node("e_back", "button", "Back"),
              node("e_forward", "button", "Forward", { states: ["showing", "visible"] }),
              // Not rendered at all: a hidden toolbar button.
              node("e_save", "button", "Save card", { states: ["enabled", "sensitive"] }),
              node("e_note", "notification", "notification", { states: [] }),
            ],
          }),
          node("e_doc", "document web", "Sign in", {
            children: [
              node("e_form", "form", "form", {
                children: [
                  node("e_heading", "heading", "Sign in", {
                    children: [node("e_heading_text", "static", "Sign in")],
                  }),
                  node("e_label", "label", "label", {
                    children: [node("e_label_text", "static", "Email")],
                  }),
                  node("e_email", "entry", "Email", {
                    states: [...shown, "focusable", "editable", "focused"],
                    actions: [...common, "set_value"],
                    value: "ada@example.com",
                  }),
                  node("e_password", "password text", "Password", {
                    value: { redacted: true, reason: "password" },
                  }),
                  // Scrolled below the viewport.
                  node("e_forgot", "button", "Forgot password?", {
                    states: ["enabled", "sensitive", "visible"],
                  }),
                  node("e_menu", "button", "Appearance", {
                    states: [...shown, "expandable"],
                    actions: [...common, "collapse", "expand"],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];
    const text = computerObservationText(
      observation({ kind: "snapshot", roots, nodeCount: 15 }, "e_email"),
    );
    expect(text).toBe(
      [
        'window window:1 "Sign in - Chromium" pid 42 at 9,9 size 1052x842 focused',
        "Observation o_1, target generation g_1, frame f_1",
        "Screenshot 960x768 pixels; pointer x,y use these pixels.",
        '- frame "Sign in - Chromium" [e_frame]',
        '  - button "Back" [e_back]',
        '  - button "Forward" [e_forward] disabled',
        '  - document web "Sign in" [e_doc]',
        "    - form",
        '      - heading "Sign in"',
        '      - static "Email"',
        '      - entry "Email" [e_email] value="ada@example.com" focused (set_value)',
        '      - password text "Password" [e_password] value=<redacted>',
        '      - button "Forgot password?" [e_forgot] offscreen',
        '      - button "Appearance" [e_menu] collapsed (expand)',
        "(5 hidden, unlabeled or repeated elements not shown)",
      ].join("\n"),
    );
  });

  test("keeps every node of a flat CUA forest that has something to read or do", () => {
    const roots: ComputerTextNode[] = [
      { ref: "s1:0", role: "window", name: "Activity Monitor", states: [], actions: [] },
      { ref: "s1:1", role: "button", name: "Stop", states: ["disabled"], actions: ["invoke"] },
      { ref: "read-only:2", role: "text", name: "CPU", states: [], actions: [] },
      { ref: "read-only:3", role: "AXRow", states: [], actions: [] },
      {
        ref: "s1:4",
        role: "textbox",
        name: "Search",
        value: "bun",
        states: ["focused"],
        actions: ["set_value"],
      },
    ];
    const text = computerObservationText(observation({ kind: "snapshot", roots, nodeCount: 5 }));
    expect(text.split("\n").slice(3)).toEqual([
      '- window "Activity Monitor" [s1:0]',
      '- button "Stop" [s1:1] disabled',
      '- text "CPU"',
      '- textbox "Search" [s1:4] value="bun" focused (set_value)',
      "(1 hidden, unlabeled or repeated element not shown)",
    ]);
  });

  test("says when the platform stopped reading the tree early", () => {
    const roots = [node("e_row", "AXRow", "bun")];
    const slow = computerObservationText(
      observation({
        kind: "snapshot",
        roots,
        nodeCount: 1,
        incomplete: { reason: "time_budget", unreadCount: 567 },
      }),
    );
    expect(slow.split("\n").at(-1)).toBe(
      "Partial tree: reading stopped because the app answered too slowly; at least 567 more elements were not read. Elements not listed here may still exist; use the screenshot for them.",
    );
    const capped = computerObservationText(
      observation({
        kind: "snapshot",
        roots,
        nodeCount: 1,
        incomplete: { reason: "node_budget", unreadCount: 1 },
      }),
    );
    expect(capped).toContain(
      "reading stopped because it reached its element limit; at least 1 more element was not read.",
    );
    const whole = computerObservationText(observation({ kind: "snapshot", roots, nodeCount: 1 }));
    expect(whole).not.toContain("Partial tree");
  });

  test("reports diffs, removed elements, a missing tree and a focus outside the view", () => {
    const diff = computerObservationText(
      observation(
        {
          kind: "diff",
          baseObservationId: "o_0",
          removedRefs: ["e_old", "e_older"],
          changed: [node("e_ok", "button", "OK")],
        },
        "e_elsewhere",
      ),
    );
    expect(diff.split("\n").slice(3)).toEqual([
      "Focused element: e_elsewhere",
      "Changed elements since o_0:",
      '- button "OK" [e_ok]',
      "(2 earlier elements removed)",
    ]);
    expect(computerObservationText(observation(null))).toEndWith(
      "No accessibility tree is available for this target; use the screenshot.",
    );
  });

  test("clips long fields", () => {
    const text = computerObservationText(
      observation({
        kind: "snapshot",
        roots: [
          node("e_doc", "text", "Editor", {
            actions: [...common, "set_value"],
            value: "x".repeat(5_000),
          }),
        ],
        nodeCount: 1,
      }),
    );
    expect(text).toContain(`value="${"x".repeat(2_000)}…"`);
    expect(text).toEndWith("(1 long field clipped)");
  });
});

describe("computer session and action text", () => {
  const target = {
    id: "window:1",
    kind: "window",
    title: "Calculator",
    processId: 7,
    bounds: { x: 0, y: 0, width: 300, height: 400 },
    focused: false,
  };

  test("names the session, what it cannot do, and its targets", () => {
    const text = computerOpenText({
      session: {
        id: "c1",
        lifecycle: "active",
        placement: { kind: "connected_machine" },
        platform: "macos",
        adapter: "opengeni.cua.macos.v1",
        displayId: null,
        capabilities: {
          semanticObservation: true,
          appLaunch: false,
          screenCapture: false,
          clipboard: false,
          backgroundInput: true,
        },
        failureCode: null,
      },
      targets: [{ ...target, id: "app:1", kind: "app", title: "Calculator", bounds: null }, target],
    });
    expect(text).toBe(
      [
        "ComputerSession c1 (active): macos on a Connected Machine, adapter opengeni.cua.macos.v1",
        "Not available: app launch, screen screenshots, clipboard",
        "Pointer and keyboard input stay in the background.",
        "2 targets:",
        'app app:1 "Calculator" pid 7',
        'window window:1 "Calculator" pid 7 at 0,0 size 300x400',
      ].join("\n"),
    );
  });

  test("reports the action state, its error and the observation after it", () => {
    const text = computerActionText({
      operationId: "op-1",
      targetId: "window:1",
      state: "failed",
      error: { code: "locator_not_found", message: "No element matched", retryable: false },
      observation: null,
    });
    expect(text).toBe(
      [
        "Action failed on window:1 (operation op-1).",
        "Error locator_not_found: No element matched",
      ].join("\n"),
    );
  });
});
