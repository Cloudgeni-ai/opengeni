import { expect, test } from "bun:test";
import { InteractionSemanticNode } from "@opengeni/contracts";
import { projectElements, unindexedTextByElement } from "../src/cua/projection";

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
  // CUA emits disabled controls as unindexed rows, value included. Their text
  // must not become an indexed ancestor's name or description, and neither may
  // anything nested inside them or a value-derived label.
  const markdown = [
    '- [0] Window "Settings" [actions=[raise]]',
    "    - [1] Group",
    '        - Text "API key"',
    '        - Edit "API key" = "synthetic-sensitive-value"',
    '        - Edit "synthetic-label-from-value"',
    "        - Edit",
    '            - Text = "synthetic-nested-value"',
    '    - [2] Edit "Name" = "typed text" [actions=[set_value]]',
    '        - Text = "synthetic-inside-indexed-edit"',
  ].join("\n");
  const texts = unindexedTextByElement(markdown, "windows");
  expect([...texts.entries()]).toEqual([[1, ["API key"]]]);
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
  expect(nodes[1]!.name).toBe("API key");
});
