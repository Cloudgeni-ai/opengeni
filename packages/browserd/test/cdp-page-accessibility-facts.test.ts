import { describe, expect, test } from "bun:test";
import {
  namespaceCdpAccessibilityFrame,
  normalizeCdpAccessibilityTree,
  withPageAccessibilityFacts,
  type CdpAxNode,
  type PageRevealedNode,
} from "../src/cdp-accessibility";

const FRAME = "frame-1";
const hidden = (reason: string) => ({
  ignored: true,
  ignoredReasons: [{ name: reason, value: { type: "boolean", value: true } }],
  role: { value: "none" },
});

// A nav with a button and an aria-hidden submenu (backend 17) that Chromium
// lists without the items inside it, and a chevron button (backend 30).
const RAW: CdpAxNode[] = namespaceCdpAccessibilityFrame(
  FRAME,
  [
    {
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: "Admin" },
      childIds: ["11"],
      backendDOMNodeId: 1,
    },
    {
      nodeId: "11",
      parentId: "1",
      role: { value: "navigation" },
      childIds: ["14", "17", "30"],
      backendDOMNodeId: 11,
    },
    {
      nodeId: "14",
      parentId: "11",
      role: { value: "button" },
      name: { value: "Administration" },
      childIds: [],
      backendDOMNodeId: 14,
    },
    {
      nodeId: "17",
      parentId: "11",
      ...hidden("ariaHiddenElement"),
      childIds: [],
      backendDOMNodeId: 17,
    },
    {
      nodeId: "30",
      parentId: "11",
      role: { value: "button" },
      name: { value: "browse options" },
      childIds: ["31"],
      backendDOMNodeId: 30,
    },
    {
      nodeId: "31",
      parentId: "30",
      role: { value: "StaticText" },
      name: { value: "v" },
      childIds: [],
      backendDOMNodeId: 31,
    },
  ],
  `${FRAME}\0loader-1`,
);

const fact = (
  backendNodeId: number,
  role: string,
  name: string,
  parent: number,
  ancestors: number[] = [],
): PageRevealedNode => ({
  backendNodeId,
  role,
  name,
  properties: role === "menuitem" ? [{ name: "focusable", value: { value: true } }] : [],
  parent,
  ancestors,
});

const snapshot = (nodes: CdpAxNode[]) =>
  normalizeCdpAccessibilityTree({
    nodes,
    controllerGeneration: "controller-1",
    targetId: "target-1",
    documentGeneration: "document-1",
  });

describe("withPageAccessibilityFacts", () => {
  test("adds what an aria-hidden element holds under it, actionable and found by text", () => {
    const nodes = withPageAccessibilityFacts(RAW, FRAME, {
      revealed: [
        fact(17, "menu", "", -1, [11]),
        fact(18, "menuitem", "Users", 0),
        fact(19, "StaticText", "Users", 1),
        null,
        fact(21, "menuitem", "Roles", 0),
      ],
      decorations: new Set(),
    });
    const result = snapshot(nodes);
    const users = result.entries.find(
      (entry) => entry.name === "Users" && entry.role === "menuitem",
    )!;
    expect(users.actions).toEqual(["click"]);
    expect(users.revealed).toBe(true);
    expect(users.backendDOMNodeId).toBe(18);
    expect(result.entries.some((entry) => entry.role === "text" && entry.name === "Users")).toBe(
      true,
    );
    expect(result.entries.find((entry) => entry.backendDOMNodeId === 17)?.role).toBe("menu");
    // The menu sits where the page put it, in the navigation.
    const navigation = result.roots[0]!.children!.find((node) => node.role === "navigation")!;
    const menu = navigation.children!.find((node) => node.role === "menu")!;
    expect(menu.children!.map((node) => node.name)).toEqual(["Users", "Roles"]);
    // An added node gets the id Chromium gives a DOM-backed node.
    expect(nodes.find((node) => node.backendDOMNodeId === 18)?.nodeId).toBe(
      [FRAME, "loader-1", "18"].join("\0"),
    );
  });

  test("leaves nodes Chromium exposes unchanged and drops roots it cannot place", () => {
    const nodes = withPageAccessibilityFacts(RAW, FRAME, {
      revealed: [fact(14, "generic", "", -1, [11]), fact(40, "link", "Lost", -1, [99])],
      decorations: new Set(),
    });
    const result = snapshot(nodes);
    expect(result.entries.find((entry) => entry.backendDOMNodeId === 14)?.role).toBe("button");
    expect(result.entries.some((entry) => entry.name === "Lost")).toBe(false);
  });

  test("a decoration stays resolvable but is left out of the outline", () => {
    const result = snapshot(
      withPageAccessibilityFacts(RAW, FRAME, { revealed: [], decorations: new Set([30]) }),
    );
    expect(result.entries.find((entry) => entry.name === "browse options")?.actions).toEqual([
      "click",
    ]);
    const shown: string[] = [];
    const walk = (node: {
      name?: string | undefined;
      children?: readonly unknown[] | undefined;
    }) => {
      if (node.name) shown.push(node.name);
      for (const child of node.children ?? []) walk(child as typeof node);
    };
    for (const root of result.roots) walk(root);
    expect(shown).toContain("Administration");
    expect(shown).not.toContain("browse options");
    expect(shown).not.toContain("v");
  });
});
