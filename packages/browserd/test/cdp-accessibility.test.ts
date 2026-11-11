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

  test("projects form field values but reports a masked password as redacted", () => {
    const field = (nodeId: string, name: string, value: string) => ({
      nodeId,
      ignored: false,
      role: { value: "textbox" },
      name: { value: name },
      value: { value },
      backendDOMNodeId: Number(nodeId),
      childIds: [`${nodeId}0`],
    });
    const text = (nodeId: string, parentId: string, name: string) => ({
      nodeId,
      parentId,
      ignored: false,
      role: { value: "StaticText" },
      name: { value: name },
    });
    const snapshot = normalizeCdpAccessibilityTree({
      controllerGeneration: "controller-1",
      targetId: "target-1",
      documentGeneration: "document-1",
      nodes: [
        { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, childIds: ["2", "3"] },
        { ...field("2", "Draft", "Reference 4821"), parentId: "1" },
        text("20", "2", "Reference 4821"),
        { ...field("3", "Password", "\u2022\u2022\u2022\u2022\u2022\u2022"), parentId: "1" },
        text("30", "3", "\u2022\u2022\u2022\u2022\u2022\u2022"),
      ],
    });

    const [draft, password] = snapshot.roots[0]!.children!;
    expect(draft).toMatchObject({ role: "textbox", name: "Draft", value: "Reference 4821" });
    expect(draft).not.toHaveProperty("children");
    expect(password).toMatchObject({
      role: "textbox",
      name: "Password",
      value: { redacted: true, reason: "password" },
    });
    expect(JSON.stringify(snapshot.roots)).not.toContain("\u2022");
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

  test("keeps refs of nodes without a DOM node when Chromium rebuilds the tree", () => {
    // A rebuilt tree gives CSS generated text a new negative id; DOM-backed
    // nodes keep their DOM node ids.
    const tree = (generated: [string, string]): CdpAxNode[] => [
      {
        nodeId: "1",
        ignored: false,
        role: { value: "RootWebArea" },
        name: { value: "Files" },
        backendDOMNodeId: 1,
        childIds: ["4"],
      },
      {
        nodeId: "4",
        parentId: "1",
        ignored: false,
        role: { value: "paragraph" },
        backendDOMNodeId: 4,
        childIds: [generated[0], "5", generated[1]],
      },
      {
        nodeId: generated[0],
        parentId: "4",
        ignored: false,
        role: { value: "StaticText" },
        name: { value: "Note: " },
      },
      {
        nodeId: "5",
        parentId: "4",
        ignored: false,
        role: { value: "StaticText" },
        name: { value: "Body" },
        backendDOMNodeId: 5,
      },
      {
        nodeId: generated[1],
        parentId: "4",
        ignored: false,
        role: { value: "StaticText" },
        name: { value: " (required)" },
      },
    ];
    const refs = (nodes: CdpAxNode[]) =>
      normalizeCdpAccessibilityTree({
        controllerGeneration: "controller-1",
        targetId: "target-1",
        documentGeneration: "document-1",
        nodes: namespaceCdpAccessibilityFrame("frame-1", nodes),
      }).entries.map((entry) => `${entry.name}=${entry.ref}`);
    const first = refs(tree(["-1000000008", "-1000000009"]));
    expect(refs(tree(["-1000000025", "-1000000026"]))).toEqual(first);
    expect(new Set(first.map((entry) => entry.split("=")[1])).size).toBe(first.length);
    expect(first.filter((entry) => /=a[0-9a-f]{8}$/.test(entry))).toHaveLength(2);
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

describe("protected page content", () => {
  const text = (nodeId: string, backendDOMNodeId: number, name: string): CdpAxNode => ({
    nodeId,
    ignored: false,
    role: { value: "StaticText" },
    name: { value: name },
    backendDOMNodeId,
  });
  const fromContents = (value: string) => ({
    value,
    sources: [{ type: "contents", value: { type: "computedString", value } }],
  });
  const related = (backendDOMNodeId: number) => ({
    type: "idrefList",
    value: `id-${backendDOMNodeId}`,
    relatedNodes: [{ backendDOMNodeId, idref: `id-${backendDOMNodeId}` }],
  });
  const normalize = (nodes: CdpAxNode[]) =>
    normalizeCdpAccessibilityTree({
      controllerGeneration: "controller-1",
      targetId: "target-1",
      documentGeneration: "document-1",
      nodes,
    });
  const tree = (marked: boolean): CdpAxNode[] => {
    const mark = (reason: "password" | "payment" | "private") =>
      marked ? { protectedReason: reason } : {};
    return [
      {
        nodeId: "1",
        ignored: false,
        role: { value: "RootWebArea" },
        childIds: ["2", "3", "4", "5", "6", "7", "8"],
        backendDOMNodeId: 1,
      },
      // A private text field: present, labelled and fillable.
      {
        nodeId: "2",
        ignored: false,
        role: { value: "textbox" },
        name: { value: "Notes" },
        value: { value: "secret note" },
        childIds: ["20"],
        backendDOMNodeId: 2,
        ...mark("private"),
      },
      text("20", 20, "secret note"),
      // A payment select: its options are what it holds.
      {
        nodeId: "3",
        ignored: false,
        role: { value: "combobox" },
        name: { value: "Expiry" },
        value: { value: "12/30" },
        childIds: ["30"],
        backendDOMNodeId: 3,
        ...mark("payment"),
      },
      {
        nodeId: "30",
        ignored: false,
        role: { value: "MenuListPopup" },
        childIds: ["31"],
        backendDOMNodeId: 30,
      },
      {
        nodeId: "31",
        ignored: false,
        role: { value: "MenuListOption" },
        name: { value: "12/30" },
        properties: [{ name: "selected", value: { type: "boolean", value: true } }],
        backendDOMNodeId: 31,
      },
      // A button whose name includes a private span.
      {
        nodeId: "4",
        ignored: false,
        role: { value: "button" },
        name: fromContents("Pay 42 now"),
        childIds: ["40", "41", "42"],
        backendDOMNodeId: 4,
      },
      text("40", 40, "Pay"),
      { ...text("41", 41, "42"), ...mark("private") },
      text("42", 42, "now"),
      // A button labelled and described by private text and public text.
      {
        nodeId: "5",
        ignored: false,
        role: { value: "button" },
        name: {
          value: "Ending 4242 Confirm",
          sources: [
            {
              type: "relatedElement",
              attribute: "aria-labelledby",
              attributeValue: {
                type: "idrefList",
                value: "id-6 id-7",
                relatedNodes: [{ backendDOMNodeId: 6 }, { backendDOMNodeId: 7 }],
              },
              value: { type: "computedString", value: "Ending 4242 Confirm" },
            },
          ],
        },
        description: { value: "Ending 4242" },
        properties: [{ name: "describedby", value: related(6) }],
        backendDOMNodeId: 5,
      },
      {
        nodeId: "6",
        ignored: false,
        role: { value: "generic" },
        childIds: ["60"],
        backendDOMNodeId: 6,
        ...mark("payment"),
      },
      text("60", 60, "Ending 4242"),
      {
        nodeId: "7",
        ignored: false,
        role: { value: "generic" },
        childIds: ["70"],
        backendDOMNodeId: 7,
      },
      text("70", 70, "Confirm"),
      // A link inside a private block: its address is what it holds.
      {
        nodeId: "8",
        ignored: false,
        role: { value: "link" },
        name: fromContents("statement"),
        properties: [
          { name: "url", value: { type: "string", value: "https://bank.test/acct/42" } },
        ],
        childIds: ["80"],
        backendDOMNodeId: 8,
        ...mark("private"),
      },
      text("80", 80, "statement"),
    ];
  };

  test("a marked node shows that it holds something, never what", () => {
    const snapshot = normalize(tree(true));
    const [notes, expiry, pay, confirm, , , link] = snapshot.roots[0]!.children!;
    expect(notes).toEqual({
      ref: notes!.ref,
      role: "textbox",
      name: "Notes",
      value: { redacted: true, reason: "private" },
      states: [],
      actions: ["focus", "fill", "type", "press"],
    });
    expect(expiry).toMatchObject({
      role: "combobox",
      name: "Expiry",
      value: { redacted: true, reason: "payment" },
    });
    expect(expiry).not.toHaveProperty("children");
    expect(pay).toMatchObject({ role: "button", name: "Pay now" });
    expect(pay!.children!.map((child) => child.name ?? child.value)).toEqual([
      "Pay",
      { redacted: true, reason: "private" },
      "now",
    ]);
    expect(confirm).toMatchObject({ role: "button", name: "Confirm" });
    expect(confirm).not.toHaveProperty("description");
    expect(link).toMatchObject({ role: "link", actions: ["click"] });
    expect(link).not.toHaveProperty("name");
    expect(link!.states).toEqual([]);
    const shown = JSON.stringify(snapshot.roots);
    for (const secret of ["secret note", "12/30", "Pay 42", "4242", "bank.test", "statement"]) {
      expect(shown).not.toContain(secret);
    }
    expect(InteractionSemanticNode.safeParse(snapshot.roots[0]).success).toBe(true);
  });

  test("an unmarked tree is shown as before", () => {
    const shown = JSON.stringify(normalize(tree(false)).roots);
    for (const expected of [
      "secret note",
      "12/30",
      "Pay 42 now",
      "Ending 4242 Confirm",
      "bank.test",
    ]) {
      expect(shown).toContain(expected);
    }
  });

  test("a protected field keeps its label only when the label was read whole", () => {
    const field = (rootChildIds: string[], labelChildIds: string[] | null): CdpAxNode[] => [
      {
        nodeId: "1",
        ignored: false,
        role: { value: "RootWebArea" },
        childIds: rootChildIds,
        backendDOMNodeId: 1,
      },
      ...(labelChildIds
        ? [
            {
              nodeId: "9",
              ignored: false,
              role: { value: "LabelText" },
              childIds: labelChildIds,
              backendDOMNodeId: 9,
            },
          ]
        : []),
      {
        nodeId: "10",
        ignored: false,
        role: { value: "textbox" },
        name: {
          value: "Password",
          sources: [
            {
              type: "relatedElement",
              nativeSource: "labelwrapped",
              nativeSourceValue: { type: "nodeList", relatedNodes: [{ backendDOMNodeId: 9 }] },
              value: { type: "computedString", value: "Password" },
            },
          ],
        },
        value: { value: "hunter2" },
        backendDOMNodeId: 10,
        protectedReason: "password",
      },
    ];
    const fieldName = (nodes: CdpAxNode[]) =>
      normalize(nodes).entries.find((entry) => entry.backendDOMNodeId === 10)?.name ?? null;
    // The label and its text were read: the field shows its label.
    expect(fieldName([...field(["9"], ["90", "10"]), text("90", 90, "Password")])).toBe("Password");
    // A partial read left out the label's text, or the label itself: what
    // was not read cannot be shown to be public, so the field is unnamed.
    expect(fieldName(field(["9"], ["90", "10"]))).toBeNull();
    expect(fieldName(field(["10"], null))).toBeNull();
  });
});
