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
    [3, ["hunter2"]],
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
