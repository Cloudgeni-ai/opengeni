import { describe, expect, test } from "bun:test";
import { InteractionSemanticNode } from "@opengeni/contracts";
import {
  namespaceCdpAccessibilityFrame,
  normalizeCdpAccessibilityTree,
  type CdpAxNode,
} from "../src";
import { semanticRef } from "../src/cdp-accessibility";

describe("semanticRef", () => {
  const identity = {
    controllerGeneration: "controller-1",
    targetId: "target-1",
    documentGeneration: "document-1",
    frameId: null,
    nodeId: "7",
    backendDOMNodeId: 9,
  };

  test("is short, kind-prefixed and scoped to the exact document", () => {
    const ref = semanticRef(identity, new Set());
    expect(ref).toMatch(/^e[0-9a-f]{8}$/);
    expect(semanticRef({ ...identity, backendDOMNodeId: null }, new Set())).toMatch(
      /^a[0-9a-f]{8}$/,
    );
    expect(semanticRef({ ...identity, documentGeneration: "document-2" }, new Set())).not.toBe(ref);
  });

  test("falls back to the full digest when the short form is taken in the snapshot", () => {
    const short = semanticRef(identity, new Set());
    const long = semanticRef(identity, new Set([short]));
    expect(long).toMatch(/^e[0-9a-f]{16}$/);
    expect(long.startsWith(short)).toBe(true);
  });
});

describe("normalizeCdpAccessibilityTree", () => {
  test("offers fill on native date and time inputs, not on their part spin buttons", () => {
    const snapshot = normalizeCdpAccessibilityTree({
      controllerGeneration: "controller-1",
      targetId: "target-1",
      documentGeneration: "document-1",
      nodes: [
        {
          nodeId: "1",
          ignored: false,
          role: { value: "InputTime" },
          name: { value: "Start" },
          value: { value: "07:00" },
          backendDOMNodeId: 10,
          childIds: ["2", "5"],
        },
        {
          nodeId: "2",
          parentId: "1",
          ignored: false,
          role: { value: "generic" },
          backendDOMNodeId: 11,
          childIds: ["3"],
        },
        {
          nodeId: "3",
          parentId: "2",
          ignored: false,
          role: { value: "spinbutton" },
          name: { value: "Hours" },
          backendDOMNodeId: 12,
        },
        {
          nodeId: "5",
          parentId: "1",
          ignored: false,
          role: { value: "spinbutton" },
          name: { value: "Quantity" },
          backendDOMNodeId: 13,
        },
        {
          nodeId: "6",
          ignored: false,
          role: { value: "spinbutton" },
          name: { value: "Count" },
          backendDOMNodeId: 14,
        },
      ],
    });
    const byName = new Map([...snapshot.entriesByRef.values()].map((entry) => [entry.name, entry]));
    expect(byName.get("Start")?.actions).toEqual(["focus", "fill"]);
    expect(byName.get("Hours")?.actions).toEqual(["focus", "type", "press"]);
    expect(byName.get("Quantity")?.actions).toEqual(["focus", "type", "press"]);
    expect(byName.get("Count")?.actions).toEqual(["focus", "fill", "type", "press"]);
  });

  test("promotes ignored ancestors, preserves static text, and keeps native ids private", () => {
    const snapshot = normalizeCdpAccessibilityTree({
      controllerGeneration: "controller-1",
      targetId: "target-1",
      documentGeneration: "document-1",
      nodes: fixtureNodes(),
    });

    expect(snapshot.nodeCount).toBe(5);
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots[0]).toMatchObject({ role: "main" });
    expect(snapshot.roots[0]?.children?.map((node) => node.role)).toEqual([
      "heading",
      "paragraph",
      "button",
    ]);
    expect(snapshot.roots[0]?.children?.[1]?.children?.[0]).toMatchObject({
      role: "text",
      name: "Important static text",
      actions: [],
    });
    expect(snapshot.focusedRef).toMatch(/^e[0-9a-f]{8}$/);
    expect(snapshot.entriesByRef.get(snapshot.focusedRef!)?.backendDOMNodeId).toBe(9);
    expect(JSON.stringify(snapshot.roots)).not.toContain("backendDOMNodeId");
  });

  test("does not project editable control values", () => {
    const snapshot = normalizeCdpAccessibilityTree({
      controllerGeneration: "controller-1",
      targetId: "target-1",
      documentGeneration: "document-1",
      nodes: [
        {
          nodeId: "1",
          ignored: false,
          role: { value: "textbox" },
          name: { value: "Password" },
          value: { value: "super-secret" },
          backendDOMNodeId: 42,
          childIds: ["2"],
        },
        {
          nodeId: "2",
          parentId: "1",
          ignored: false,
          role: { value: "generic" },
          childIds: ["3"],
        },
        {
          nodeId: "3",
          parentId: "2",
          ignored: false,
          role: { value: "StaticText" },
          name: { value: "super-secret" },
        },
      ],
    });

    expect(snapshot.roots[0]).not.toHaveProperty("value");
    expect(JSON.stringify(snapshot.roots)).not.toContain("super-secret");
    expect(snapshot.entries).toHaveLength(1);
  });

  test("keeps colliding frame-local AX ids and backend ids independently addressable", () => {
    const frame = (frameId: string, name: string) =>
      namespaceCdpAccessibilityFrame(frameId, [
        {
          nodeId: "root",
          ignored: false,
          role: { value: "RootWebArea" },
          childIds: ["button"],
        },
        {
          nodeId: "button",
          parentId: "root",
          ignored: false,
          role: { value: "button" },
          name: { value: name },
          backendDOMNodeId: 42,
        },
      ]);
    const snapshot = normalizeCdpAccessibilityTree({
      controllerGeneration: "controller-1",
      targetId: "target-1",
      documentGeneration: "document-1",
      nodes: [...frame("frame-a", "Frame A"), ...frame("frame-b", "Frame B")],
    });

    expect(snapshot.roots).toHaveLength(2);
    expect(snapshot.entries.filter((entry) => entry.role === "button")).toHaveLength(2);
    const refs = snapshot.entries
      .filter((entry) => entry.role === "button")
      .map((entry) => entry.ref);
    expect(new Set(refs).size).toBe(2);
    expect(snapshot.entries.map((entry) => entry.frameId)).toEqual(
      expect.arrayContaining(["frame-a", "frame-b"]),
    );
  });
});

function fixtureNodes(): CdpAxNode[] {
  return [
    {
      nodeId: "1",
      ignored: true,
      role: { value: "none" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      parentId: "1",
      ignored: false,
      role: { value: "main" },
      childIds: ["3", "4", "5"],
      backendDOMNodeId: 6,
    },
    {
      nodeId: "3",
      parentId: "2",
      ignored: false,
      role: { value: "heading" },
      name: { value: "Hello" },
      backendDOMNodeId: 7,
    },
    {
      nodeId: "4",
      parentId: "2",
      ignored: false,
      role: { value: "paragraph" },
      childIds: ["6"],
      backendDOMNodeId: 8,
    },
    {
      nodeId: "5",
      parentId: "2",
      ignored: false,
      role: { value: "button" },
      name: { value: "Go" },
      properties: [{ name: "focused", value: { value: true } }],
      backendDOMNodeId: 9,
    },
    {
      nodeId: "6",
      parentId: "4",
      ignored: false,
      role: { value: "StaticText" },
      name: { value: "Important static text" },
      childIds: ["7"],
      backendDOMNodeId: 10,
    },
    {
      nodeId: "7",
      parentId: "6",
      ignored: false,
      role: { value: "InlineTextBox" },
      name: { value: "Important static text" },
    },
  ];
}

test("focused document does not replace the focused descendant select", () => {
  const snapshot = normalizeCdpAccessibilityTree({
    controllerGeneration: "controller",
    targetId: "target",
    documentGeneration: "document",
    nodes: [
      {
        nodeId: "root",
        role: { value: "RootWebArea" },
        properties: [{ name: "focused", value: { value: true } }],
        childIds: ["select"],
        backendDOMNodeId: 1,
      },
      {
        nodeId: "select",
        parentId: "root",
        role: { value: "combobox" },
        properties: [{ name: "focused", value: { value: true } }],
        backendDOMNodeId: 2,
      },
    ],
  });
  expect(snapshot.entriesByRef.get(snapshot.focusedRef!)?.backendDOMNodeId).toBe(2);
});

test("a page with document-sized accessible names still yields a valid snapshot", () => {
  const snapshot = normalizeCdpAccessibilityTree({
    controllerGeneration: "controller",
    targetId: "target",
    documentGeneration: "document",
    nodes: [
      {
        nodeId: "root",
        role: { value: "RootWebArea" },
        name: { value: "Fingerprint report" },
        childIds: ["cell"],
        backendDOMNodeId: 1,
      },
      {
        nodeId: "cell",
        parentId: "root",
        role: { value: "cell" },
        name: { value: "x".repeat(20_000) },
        description: { value: "y".repeat(9_000) },
        backendDOMNodeId: 2,
      },
    ],
  });
  const cell = snapshot.roots[0]!.children![0]!;
  expect(cell.name).toHaveLength(8_192);
  expect(cell.description).toHaveLength(8_192);
  expect(InteractionSemanticNode.safeParse(snapshot.roots[0]).success).toBe(true);
});
