import { describe, expect, test } from "bun:test";
import {
  namespaceCdpAccessibilityFrame,
  normalizeCdpAccessibilityTree,
  type CdpAxNode,
} from "../src";

describe("normalizeCdpAccessibilityTree", () => {
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
    expect(snapshot.focusedRef).toStartWith("element-");
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
