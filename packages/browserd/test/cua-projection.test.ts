import { expect, test } from "bun:test";
import { InteractionSemanticNode } from "@opengeni/contracts";
import {
  dateFields,
  dateFieldValueFromParts,
  dateFieldTyping,
  projectElements,
  unindexedTextByElement,
} from "../src/cua/projection";

test("desktop elements with document-sized labels and values still form valid nodes", () => {
  const [node] = projectElements(
    [
      {
        element_index: 1,
        element_token: "snapshot:1",
        role: "AXStaticText",
        label: "L".repeat(20_000),
        value: "V".repeat(60_000),
        actions: [],
      },
    ],
    "macos",
  );
  expect(node!.name).toHaveLength(8_192);
  expect(node!.value).toHaveLength(32_768);
  expect(InteractionSemanticNode.safeParse(node).success).toBe(true);
});

test("table rows read as the text CUA lists only in its Markdown tree", () => {
  const markdown = [
    "window_id=20 pid=402 elements=4 snapshot_id=s2",
    "element_token for row [N] = s2:N",
    "",
    '- [0] AXWindow "Activity Monitor" [actions=[raise]]',
    "    - [1] AXRow [actions=[showdefaultui]]",
    '        - AXStaticText = "bun"',
    "        - AXCell",
    '            - AXStaticText = "5,29 GB"',
    '    - [2] AXButton "Stop" [actions=[AXPress]]',
    '        - AXStaticText = "Stop"',
    '    - [3] AXSecureTextField "Password"',
    '        - AXStaticText = "hunter2"',
    '    - AXStaticText "a = b" = "say \\"hi\\""',
  ].join("\n");
  const texts = unindexedTextByElement(markdown);
  expect([...texts.entries()]).toEqual([
    [1, ["bun", "5,29 GB"]],
    [2, ["Stop"]],
    [0, ['say "hi"']],
  ]);
  const nodes = projectElements(
    [
      {
        element_index: 0,
        element_token: "s2:0",
        role: "AXWindow",
        label: "Activity Monitor",
        actions: [],
      },
      { element_index: 1, element_token: "s2:1", role: "AXRow", actions: [] },
      {
        element_index: 2,
        element_token: "s2:2",
        role: "AXButton",
        label: "Stop",
        actions: ["AXPress"],
      },
      {
        element_index: 3,
        element_token: "s2:3",
        role: "AXSecureTextField",
        label: "Password",
        actions: [],
      },
    ],
    "macos",
    texts,
  );
  expect(nodes.map(({ name, description }) => ({ name, description }))).toEqual([
    { name: "Activity Monitor", description: 'say "hi"' },
    { name: "bun | 5,29 GB", description: undefined },
    // Text that only repeats the label adds nothing.
    { name: "Stop", description: undefined },
    // Never surface text from inside a protected field.
    { name: "Password", description: undefined },
  ]);
});

test("Windows Edit text never reaches an ancestor through the Markdown tree", () => {
  // CUA emits disabled controls as unindexed rows, value included, and writes
  // values without escaping newlines, so a multi-line Edit value can contain
  // lines shaped like sibling rows. None of it may become an indexed
  // ancestor's name or description.
  const markdown = [
    '- [0] Window "Settings" [actions=[raise]]',
    "    - [1] Group",
    '        - Text "API key"',
    '        - Edit "API key" = "synthetic-sensitive-value"',
    '        - Edit "synthetic-label-from-value"',
    '        - Edit = "first line',
    '        - Text "synthetic-injected-row"',
    'last line"',
    '    - [2] Edit "Name" = "typed text" [actions=[set_value]]',
    '        - Text = "synthetic-inside-indexed-edit"',
  ].join("\n");
  const texts = unindexedTextByElement(markdown, "windows");
  expect(texts.size).toBe(0);
  const nodes = projectElements(
    [
      { element_index: 0, element_token: "s:0", role: "Window", label: "Settings", actions: [] },
      { element_index: 1, element_token: "s:1", role: "Group", actions: [] },
      {
        element_index: 2,
        element_token: "s:2",
        role: "Edit",
        label: "Name",
        value: "typed text",
        actions: ["set_value"],
      },
    ],
    "windows",
    texts,
  );
  const serialized = JSON.stringify(nodes);
  expect(serialized).not.toContain("synthetic");
  expect(serialized).not.toContain("typed text");
});

test("unindexed secure fields and their contents add no row text", () => {
  const markdown = [
    '- [0] AXWindow "Sign in"',
    "    - [1] AXGroup",
    '        - AXStaticText = "Password"',
    '        - AXSecureTextField "synthetic-label" = "synthetic-secret"',
    '            - AXStaticText = "synthetic-nested"',
  ].join("\n");
  expect([...unindexedTextByElement(markdown, "macos").entries()]).toEqual([[1, ["Password"]]]);
});

test("web pages on macOS read without context-menu actions or repeated link text", () => {
  const nodes = projectElements(
    [
      {
        element_index: 0,
        element_token: "s:0",
        role: "AXWindow",
        label: "Wiki",
        actions: ["AXRaise"],
      },
      {
        element_index: 1,
        element_token: "s:1",
        parent_index: 0,
        role: "AXPopUpButton",
        label: "Tabs",
        actions: ["AXPress", "AXShowMenu"],
      },
      {
        element_index: 2,
        element_token: "s:2",
        parent_index: 0,
        role: "AXWebArea",
        label: "Wiki",
        actions: ["AXShowMenu"],
      },
      {
        element_index: 3,
        element_token: "s:3",
        parent_index: 2,
        role: "AXLink",
        label: "Donate",
        actions: ["AXPress", "AXShowMenu"],
      },
      {
        element_index: 4,
        element_token: "s:4",
        parent_index: 3,
        role: "AXStaticText",
        label: "Donate",
        actions: ["AXShowMenu"],
      },
      {
        element_index: 5,
        element_token: "s:5",
        parent_index: 2,
        role: "AXStaticText",
        label: "Computer accessibility refers to",
        actions: ["AXShowMenu"],
      },
    ],
    "macos",
  );
  expect(nodes.map((node) => [node.ref, node.role, node.name, node.actions])).toEqual([
    ["s:0", "window", "Wiki", []],
    // Native controls keep their context menu.
    ["s:1", "combobox", "Tabs", ["invoke", "show_menu", "set_value", "focus"]],
    ["s:2", "AXWebArea", "Wiki", []],
    ["s:3", "link", "Donate", ["invoke", "focus"]],
    // The link's own text is not listed again; other page text is plain text.
    ["s:5", "text", "Computer accessibility refers to", []],
  ]);
});

test("file dialog places, folders and files open on invoke and are not edited", () => {
  const nodes = projectElements(
    [
      { element_index: 0, element_token: "s:0", role: "AXSheet", label: "Open", actions: [] },
      {
        element_index: 1,
        element_token: "s:1",
        parent_index: 0,
        role: "AXCell",
        label: "Downloads",
        actions: ["AXOpen"],
      },
      {
        element_index: 2,
        element_token: "s:2",
        parent_index: 0,
        role: "AXTextField",
        value: "report.pdf",
        actions: ["AXOpen", "AXConfirm"],
      },
      {
        element_index: 3,
        element_token: "s:3",
        parent_index: 0,
        role: "AXButton",
        label: "Open",
        actions: ["AXPress"],
      },
    ],
    "macos",
  );
  const actions = new Map(nodes.map((node) => [node.ref, node.actions]));
  expect(actions.get("s:1")).toContain("invoke");
  expect(actions.get("s:2")).toContain("invoke");
  expect(actions.get("s:2")).not.toContain("set_value");
  expect(actions.get("s:3")).toContain("invoke");
});

test("Chrome tabs are named without their live memory usage", () => {
  const tab = (index: number, label: string) => ({
    element_index: index,
    element_token: `s:${index}`,
    role: "AXRadioButton",
    label,
    actions: ["AXPress"],
  });
  const nodes = projectElements(
    [
      tab(0, "Inbox (3) - Memory usage - 85.2 MB"),
      tab(1, "Docs - High memory usage - 1.2 GB"),
      tab(2, "Player - Audio playing - Memory usage - 312 MB"),
      tab(3, "Memory usage - 10 MB notes"),
    ],
    "macos",
  );
  expect(nodes.map((node) => node.name)).toEqual([
    "Inbox (3)",
    "Docs",
    "Player - Audio playing",
    "Memory usage - 10 MB notes",
  ]);
});

/** Chrome's elements for a page with one web date or time field. */
function webDateField(
  role: "AXDateField" | "AXTimeField",
  label: string,
  parts: string[],
  value?: string,
) {
  return [
    { element_index: 0, role: "AXWindow", label: "Page", actions: [] },
    { element_index: 1, parent_index: 0, role: "AXWebArea", label: "Page", actions: [] },
    {
      element_index: 2,
      element_token: "s1:2",
      parent_index: 1,
      role,
      label,
      ...(value === undefined ? {} : { value }),
      actions: ["AXPress"],
    },
    ...parts.flatMap((part, index) => [
      {
        element_index: 3 + index * 2,
        element_token: `s1:${3 + index * 2}`,
        parent_index: 2,
        role: "AXIncrementor",
        label: `${part} ${label}`,
        value: "--",
        actions: ["AXIncrement", "AXDecrement"],
      },
      {
        element_index: 4 + index * 2,
        element_token: `s1:${4 + index * 2}`,
        parent_index: 2,
        role: "AXStaticText",
        value: "/",
        actions: [],
      },
    ]),
  ];
}

test("a web date or time field takes a value; its parts are known in the order shown", () => {
  const elements = webDateField(
    "AXDateField",
    "Date of birth",
    ["Day", "Month", "Year"],
    "1976-07-15",
  );
  expect([...dateFields(elements).entries()]).toEqual([
    [2, { segments: ["day", "month", "year"], parts: [3, 5, 7] }],
  ]);
  const field = projectElements(elements, "macos").find((node) => node.ref === "s1:2")!;
  expect(field.actions).toEqual(["invoke", "set_value", "focus"]);
  expect(field.value).toBe("1976-07-15");
  // Outside web content, or with a part named in another language, the
  // field is not one this knows how to fill.
  const native = elements.filter((element) => element.role !== "AXWebArea");
  expect(dateFields(native).size).toBe(0);
  expect(dateFields(webDateField("AXDateField", "Fødselsdato", ["Dag", "Måned", "År"])).size).toBe(
    0,
  );
  expect(projectElements(native, "macos").find((node) => node.ref === "s1:2")!.actions).toEqual([
    "invoke",
    "focus",
  ]);
});

test("a web date field Chrome left without a value reads what its parts read", () => {
  const elements = webDateField("AXDateField", "Date of birth", ["Day", "Month", "Year"], "");
  const read = (parts: string[]) =>
    projectElements(
      elements.map((element) =>
        element.role === "AXIncrementor"
          ? { ...element, value: parts[[3, 5, 7].indexOf(element.element_index)] }
          : element,
      ),
      "macos",
    ).find((node) => node.ref === "s1:2")!.value;
  expect(read(["1", "11", "1996"])).toBe("1996-11-01");
  // A part still showing its placeholder: the field reads what Chrome says.
  expect(read(["1", "mm", "1996"])).toBe("");
  expect(dateFieldValueFromParts(["hours", "minutes", "meridiem"], ["2", "05", "PM"])).toBe(
    "14:05",
  );
  expect(dateFieldValueFromParts(["hours", "minutes", "meridiem"], ["12", "15", "AM"])).toBe(
    "00:15",
  );
  expect(dateFieldValueFromParts(["month", "year"], ["7", "2031"])).toBe("2031-07");
  expect(dateFieldValueFromParts(["week", "year"], ["9", "2027"])).toBe("2027-W09");
  expect(
    dateFieldValueFromParts(
      ["day", "month", "year", "hours", "minutes"],
      ["7", "3", "2027", "14", "5"],
    ),
  ).toBe("2027-03-07T14:05");
  expect(dateFieldValueFromParts(["day", "month", "year"], ["0", "0", "0"])).toBeNull();
  expect(dateFieldValueFromParts(["day", "month"], ["1"])).toBeNull();
});

test("a date or time value becomes each part's digits in the field's own order", () => {
  expect(dateFieldTyping(["day", "month", "year"], "1976-07-15")).toEqual({
    texts: ["15", "07", "1976"],
  });
  expect(dateFieldTyping(["month", "day", "year"], "2027-3-7")).toEqual({
    texts: ["03", "07", "2027"],
  });
  expect(dateFieldTyping(["hours", "minutes"], "09:30")).toEqual({ texts: ["09", "30"] });
  expect(dateFieldTyping(["hours", "minutes", "seconds"], "09:30")).toEqual({
    texts: ["09", "30", "00"],
  });
  expect(dateFieldTyping(["hours", "minutes", "meridiem"], "14:05")).toEqual({
    texts: ["02", "05", "P"],
  });
  expect(dateFieldTyping(["hours", "minutes", "meridiem"], "00:15")).toEqual({
    texts: ["12", "15", "A"],
  });
  expect(dateFieldTyping(["month", "year"], "2031-07")).toEqual({ texts: ["07", "2031"] });
  expect(dateFieldTyping(["week", "year"], "2027-W09")).toEqual({ texts: ["09", "2027"] });
  expect(dateFieldTyping(["day", "month", "year", "hours", "minutes"], "2027-03-07T14:05")).toEqual(
    { texts: ["07", "03", "2027", "14", "05"] },
  );
  // A value that does not fit names the form the field takes.
  for (const [segments, value, form] of [
    [["day", "month", "year"], "07/15/1976", "YYYY-MM-DD"],
    [["day", "month", "year"], "1976-07", "YYYY-MM-DD"],
    [["day", "month", "year"], "1976-13-01", "YYYY-MM-DD"],
    [["day", "month", "year"], "2027-03-07T14:05", "YYYY-MM-DD"],
    [["day", "month", "year", "hours", "minutes"], "2027-03-07", "YYYY-MM-DDTHH:MM"],
    [["week", "year"], "2027-03", "YYYY-Www"],
    [["hours", "minutes", "seconds"], "9.30", "HH:MM:SS"],
  ] as const)
    expect(dateFieldTyping(segments, value)).toEqual({
      error: `This date or time field takes its whole value in the form ${form}`,
    });
});
