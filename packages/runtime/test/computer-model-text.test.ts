import { describe, expect, test } from "bun:test";
import {
  computerActionText,
  computerObservationDiff,
  computerObservationText,
  computerOpenText,
  computerTargetsText,
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

  test("lists a macOS menu bar's plain items on one line", () => {
    const item = (ref: string, name: string, extra: Partial<ComputerTextNode> = {}) =>
      ({
        ref,
        role: "AXMenuBarItem",
        name,
        states: [],
        actions: ["invoke", "focus"],
        ...extra,
      }) satisfies ComputerTextNode;
    const roots: ComputerTextNode[] = [
      { ref: "e1", role: "button", name: "New Tab", states: [], actions: ["invoke"] },
      { ref: "e2", role: "AXMenuBar", states: [], actions: [] },
      item("e3", "Apple"),
      item("e4", "Chrome"),
      item("e5", "File"),
      // Open: it has something of its own to say, so it keeps its line.
      item("e6", "Edit", { states: ["selected"] }),
      item("e7", "View"),
      item("e8", "Help"),
    ];
    const text = computerObservationText(
      observation({ kind: "snapshot", roots, nodeCount: roots.length }),
    );
    expect(text.split("\n").slice(3)).toEqual([
      '- button "New Tab" [e1]',
      '- AXMenuBarItem "Apple" [e3], "Chrome" [e4], "File" [e5]',
      '- AXMenuBarItem "Edit" [e6] selected',
      '- AXMenuBarItem "View" [e7], "Help" [e8]',
      "(1 hidden, unlabeled or repeated element not shown)",
    ]);
  });

  test("lists a macOS table cell once though AXColumn repeats it", () => {
    const at = (x: number, y: number) => ({ x, y, width: 106, height: 19 });
    const cell = (ref: string, role: string, name: string, x: number, y: number) =>
      ({
        ref,
        role,
        name,
        ...(role === "text" ? { value: name } : {}),
        bounds: at(x, y),
        states: [],
        actions: role === "link" ? ["invoke", "focus"] : [],
      }) satisfies ComputerTextNode;
    const roots: ComputerTextNode[] = [
      { ref: "e1", role: "AXTable", name: "Accounts", states: [], actions: [] },
      { ref: "e2", role: "AXRow", states: [], actions: [] },
      cell("e3", "link", "Juniper Dental", 200, 459),
      cell("e4", "text", "AC-FRGA", 566, 459),
      cell("e5", "link", "Juniper Electric", 200, 494),
      cell("e6", "text", "AC-FRGA", 566, 494),
      { ref: "e7", role: "AXColumn", states: [], actions: [] },
      cell("e8", "link", "Juniper Dental", 200, 459),
      cell("e9", "link", "Juniper Electric", 200, 494),
      { ref: "e10", role: "AXColumn", states: [], actions: [] },
      cell("e11", "text", "AC-FRGA", 566, 459),
      cell("e12", "text", "AC-FRGA", 566, 494),
      // Another element with the same label elsewhere is still listed.
      cell("e13", "link", "Juniper Dental", 200, 900),
    ];
    const text = computerObservationText(observation({ kind: "snapshot", roots, nodeCount: 13 }));
    expect(text.split("\n").slice(3)).toEqual([
      '- AXTable "Accounts" [e1]',
      '- link "Juniper Dental" [e3]',
      '- text "AC-FRGA"',
      '- link "Juniper Electric" [e5]',
      '- text "AC-FRGA"',
      '- link "Juniper Dental" [e13]',
      "(7 hidden, unlabeled or repeated elements not shown)",
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

  test("points to the native window read when native tools own element reads", () => {
    const native = observation({
      kind: "snapshot",
      roots: [],
      nodeCount: 0,
      readByNativeTools: true,
    });
    const text = computerObservationText(native);
    expect(text.split("\n").at(-1)).toBe(
      "Elements are not listed here because this session reads them with interaction__cua_get_window_state; reading them here too would invalidate its element tokens. Call interaction__cua_get_window_state for this window's elements.",
    );
    expect(text).not.toContain("no readable elements");
    // Two empty native-owned readings are not "nothing changed".
    expect(computerObservationDiff(native, { ...native, observationId: "o_2" })).toBeNull();
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
      "Changed elements since o_0; elements not listed are unchanged and keep their refs:",
      '- button "OK" [e_ok]',
      "(2 earlier elements removed)",
    ]);
    expect(computerObservationText(observation(null))).toEndWith(
      "No accessibility tree is available for this target; use the screenshot.",
    );
  });

  test("says why a tree with only unlabeled elements lists none", () => {
    const roots = [
      { ref: "read-only:1", role: "AXGroup", states: [], actions: [] },
      { ref: "read-only:2", role: "AXGroup", states: [], actions: [] },
    ];
    const text = computerObservationText(observation({ kind: "snapshot", roots, nodeCount: 2 }));
    expect(text.split("\n").slice(3)).toEqual([
      "No element is listed: the accessibility tree's 2 elements are all hidden, unlabeled or repeated; use the screenshot.",
    ]);
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

  test("marks a window that cannot be read off screen, with one fixed note", () => {
    const offScreen = { ...target, id: "window:2", title: "Chrome", offScreen: true as const };
    const text = computerTargetsText([target, offScreen]);
    expect(text).toBe(
      [
        "2 targets:",
        'window window:1 "Calculator" pid 7 at 0,0 size 300x400',
        'window window:2 "Chrome" pid 7 at 0,0 size 300x400 off screen',
        "A window marked off screen, such as one on another Space or a full-screen app, can be neither captured nor read until it is back on screen. Minimized windows and windows of hidden apps are not marked: reading one brings it back on screen behind the person's front window.",
      ].join("\n"),
    );
    expect(computerTargetsText([target])).not.toContain("off screen");
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

  test("says which element of another role an action pressed, and how to name it", () => {
    const standIn = { actionIndex: 0, requestedRole: "button", role: "link", name: "Edit billing" };
    expect(
      computerActionText({
        operationId: "op-1",
        targetId: "window:1",
        state: "completed",
        error: null,
        observation: null,
        roleStandIns: [standIn],
      }),
    ).toBe(
      [
        "Action completed on window:1 (operation op-1).",
        'The action named button "Edit billing", but no button here has that name, so it used the link "Edit billing"; name it as role "link" next time.',
      ].join("\n"),
    );
    const batch = computerActionText({
      type: "batch",
      targetId: "window:1",
      actionCount: 2,
      steps: [
        { operationId: "op-1", state: "completed", error: null },
        { operationId: "op-2", state: "completed", error: null },
      ],
      observation: null,
      roleStandIns: [{ ...standIn, actionIndex: 1 }],
    });
    expect(batch.split("\n").at(-1)).toBe(
      'Action 2 named button "Edit billing", but no button here has that name, so it used the link "Edit billing"; name it as role "link" next time.',
    );
    // Without a stand-in, the text is unchanged.
    expect(
      computerActionText({
        operationId: "op-1",
        targetId: "window:1",
        state: "completed",
        error: null,
        observation: null,
      }),
    ).toBe("Action completed on window:1 (operation op-1).");
  });
});

describe("computerObservationDiff", () => {
  const ribbon = Array.from({ length: 12 }, (_, index) =>
    node(`e${index + 10}`, "radio", `Style ${index}`, { value: "0" }),
  );
  const reading = (id: string, roots: ComputerTextNode[]) => ({
    ...observation({ kind: "snapshot", roots, nodeCount: roots.length }),
    observationId: id,
  });

  test("an action's reading lists only what changed; unchanged refs carry over", () => {
    const before = reading("o_1", [node("e1", "textbox", "Name", { value: "" }), ...ribbon]);
    const after = reading("o_2", [
      node("e1", "textbox", "Name", { value: "Ada" }),
      ...ribbon.slice(1),
      node("e99", "button", "Save"),
    ]);
    const diff = computerObservationDiff(before, after)!;
    expect(diff.semantic).toEqual({
      kind: "diff",
      baseObservationId: "o_1",
      removedRefs: ["e10"],
      changed: [node("e1", "textbox", "Name", { value: "Ada" }), node("e99", "button", "Save")],
    });
    expect(computerObservationText(diff).split("\n").slice(3)).toEqual([
      "Changed elements since o_1; elements not listed are unchanged and keep their refs:",
      '- textbox "Name" [e1] value="Ada"',
      '- button "Save" [e99]',
      "(1 earlier element removed)",
    ]);
  });

  test("an action that changed nothing says so", () => {
    const diff = computerObservationDiff(reading("o_1", ribbon), reading("o_2", ribbon))!;
    expect(computerObservationText(diff)).toEndWith(
      "No element changed since o_1; its refs are still valid.",
    );
  });

  test("keeps the whole reading when a diff would not help or could mislead", () => {
    const base = reading("o_1", ribbon);
    // Most elements are new: another view.
    expect(
      computerObservationDiff(
        base,
        reading(
          "o_2",
          ribbon.map((item, index) => ({ ...item, ref: `n${index}` })),
        ),
      ),
    ).toBeNull();
    // Another document in the same window, or another window.
    expect(
      computerObservationDiff(base, {
        ...reading("o_2", ribbon),
        target: { ...base.target, title: "Other" },
      }),
    ).toBeNull();
    expect(
      computerObservationDiff(base, {
        ...reading("o_2", ribbon),
        target: { ...base.target, targetGeneration: "g2" },
      }),
    ).toBeNull();
    // A partial reading, or the same reading again.
    expect(
      computerObservationDiff(base, {
        ...reading("o_2", ribbon),
        semantic: {
          kind: "snapshot",
          roots: ribbon,
          nodeCount: ribbon.length,
          incomplete: { reason: "node_budget", unreadCount: 3 },
        },
      }),
    ).toBeNull();
    expect(computerObservationDiff(base, base)).toBeNull();
  });
});
