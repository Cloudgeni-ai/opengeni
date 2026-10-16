import { expect, test } from "bun:test";
import { InteractionSemanticNode } from "@opengeni/contracts";
import { projectElements } from "../src/cua/projection";

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
