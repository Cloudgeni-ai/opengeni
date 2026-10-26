import { describe, expect, test } from "bun:test";
import { INTERACTION_MAX_SEMANTIC_NODES } from "@opengeni/contracts";
import {
  BOUNDED_ACCESSIBILITY_CHILDREN,
  BOUNDED_ACCESSIBILITY_NODES,
  boundedChildWindow,
  normalizeCdpAccessibilityTree,
  type CdpAxNode,
} from "../src";
import { CdpAccessibilityTreeTooLargeError } from "../src/cdp-accessibility";

const children = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ nodeId: String(index) }));
const ids = (nodes: readonly { nodeId: string }[]) => nodes.map((node) => Number(node.nodeId));

describe("bounded accessibility reads", () => {
  test("stay within the semantic-node bound", () => {
    expect(BOUNDED_ACCESSIBILITY_NODES).toBeLessThanOrEqual(INTERACTION_MAX_SEMANTIC_NODES);
  });

  test("keep every child of a short list", () => {
    expect(ids(boundedChildWindow(children(BOUNDED_ACCESSIBILITY_CHILDREN), new Set()))).toEqual([
      ...Array(BOUNDED_ACCESSIBILITY_CHILDREN).keys(),
    ]);
  });

  test("keep a window of a long list around its first on-screen child", () => {
    const list = children(1_000);
    const quarter = BOUNDED_ACCESSIBILITY_CHILDREN / 4;
    const around = ids(boundedChildWindow(list, new Set(["500", "510"])));
    expect(around[0]).toBe(500 - quarter);
    expect(around).toHaveLength(BOUNDED_ACCESSIBILITY_CHILDREN);
    expect(around).toContain(510);
    // Near the end the window ends with the list.
    expect(ids(boundedChildWindow(list, new Set(["995"]))).at(-1)).toBe(999);
    // Without anything on screen, the list starts at its beginning.
    expect(ids(boundedChildWindow(list, new Set()))[0]).toBe(0);
    // A widened window (budget left over) keeps more, still around the anchor.
    const wide = ids(boundedChildWindow(list, new Set(["500"]), 400));
    expect(wide).toHaveLength(400);
    expect(wide[0]).toBe(400);
  });

  test("an outline read within a budget says how much it left unread", () => {
    const nodes: CdpAxNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { value: "RootWebArea" },
        childIds: ["2", "3"],
        backendDOMNodeId: 1,
      },
      {
        nodeId: "2",
        parentId: "1",
        ignored: false,
        role: { value: "button" },
        name: { value: "Create" },
        childIds: [],
        backendDOMNodeId: 2,
      },
    ];
    const options = { controllerGeneration: "c", targetId: "t", documentGeneration: "d" };
    expect(normalizeCdpAccessibilityTree({ nodes, ...options }).incomplete).toBeUndefined();
    expect(
      normalizeCdpAccessibilityTree({ nodes, ...options, unreadCount: 41 }).incomplete,
    ).toEqual({ reason: "node_budget", unreadCount: 41 });
  });

  test("a whole tree beyond the observation's bounds is reported as too large to read whole", () => {
    const nodes: CdpAxNode[] = Array.from(
      { length: INTERACTION_MAX_SEMANTIC_NODES * 4 + 1 },
      (_, index) => ({ nodeId: String(index + 1), ignored: true, childIds: [] }),
    );
    expect(() =>
      normalizeCdpAccessibilityTree({
        nodes,
        controllerGeneration: "c",
        targetId: "t",
        documentGeneration: "d",
      }),
    ).toThrow(CdpAccessibilityTreeTooLargeError);
  });
});
