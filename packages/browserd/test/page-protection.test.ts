import { describe, expect, test } from "bun:test";
import {
  pageProtection,
  protectedNodeKey,
  sensitiveFieldReason,
  SENSITIVE_FIELD_REASON_SOURCE,
} from "../src/page-protection";

describe("sensitiveFieldReason", () => {
  const browserPolicy = new Function(
    `return (${SENSITIVE_FIELD_REASON_SOURCE})`,
  )() as typeof sensitiveFieldReason;
  test.each([
    ["input", { autocomplete: "section-billing cc-number" }, false, "payment"],
    ["input", { "aria-label": "Security code" }, false, "payment"],
    ["input", { id: "cardNumber" }, false, "payment"],
    ["input", { name: "cvc" }, false, "payment"],
    ["input", { type: "password" }, false, "password"],
    ["input", { autocomplete: "one-time-code" }, false, "password"],
    ["span", { "data-private": "" }, false, "private"],
    ["div", { id: "card-number" }, true, "payment"],
    ["div", { id: "card-number" }, false, "payment"],
    ["h1", { id: "credit-card-offers" }, false, null],
    ["select", { id: "link-expiration" }, false, null],
    ["input", { name: "orderNumber" }, false, null],
  ] as const)("the native and browser policy agree for %s %j", (tag, attrs, editable, reason) => {
    expect(sensitiveFieldReason(tag, attrs, editable)).toBe(reason);
    expect(browserPolicy(tag, attrs, editable)).toBe(reason);
  });
  test.each(["credit_card[year]", "credit_card[zip]"])(
    "%s protects its field without remembering ordinary numeric values",
    (name) => {
      for (const policy of [sensitiveFieldReason, browserPolicy]) {
        expect(policy("input", { name }, false)).toBe("payment");
        expect(policy("input", { name }, false, "remember")).toBeNull();
      }
    },
  );
});

test("an unnamed payment field remembers full card numbers but not hidden numeric metadata", () => {
  const protection = pageProtection({
    strings: [
      "frame-a",
      "DIV",
      "INPUT",
      "id",
      "credit-card",
      "type",
      "hidden",
      "4000 0000 0000 0002",
      "40123456789012",
    ],
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3],
          parentIndex: [-1, 0, 0],
          nodeName: [1, 2, 2],
          nodeValue: [-1, -1, -1],
          attributes: [[3, 4], [], [5, 6]],
          inputValue: { index: [1, 2], value: [7, 8] },
        },
      },
    ],
  });
  expect(protection.payment).toBe(true);
  expect(protection.values).toEqual(["4000 0000 0000 0002"]);
});

test("snapshot protection includes flattened closed roots, inherited private text, values and frame scoping", () => {
  const strings = [
    "frame-a",
    "DIV",
    "INPUT",
    "#text",
    "",
    "data-private",
    "autocomplete",
    "cc-csc",
    "731",
    "private note",
  ];
  const snapshot = {
    strings,
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3],
          parentIndex: [-1, 0, 0],
          nodeName: [1, 2, 3],
          nodeValue: [-1, -1, 9],
          attributes: [[5, 4], [6, 7], []],
          inputValue: { index: [1], value: [8] },
          shadowRootType: { index: [1], value: [4] },
        },
      },
    ],
  };
  const protection = pageProtection(snapshot);
  expect(protection.payment).toBe(true);
  expect(protection.nodes.get(protectedNodeKey("frame-a", 2))).toBe("payment");
  expect(protection.nodes.get(protectedNodeKey("frame-b", 2))).toBeUndefined();
  expect(protection.values).toEqual(["731"]);
  expect(protection.nodes.get(protectedNodeKey("frame-a", 3))).toBe("private");
});

test("hidden metadata, private prose and expiry options are protected in place, not remembered as secrets", () => {
  const strings = [
    "frame-a",
    "DIV",
    "INPUT",
    "SELECT",
    "OPTION",
    "#text",
    "",
    "type",
    "hidden",
    "name",
    "id",
    "currency",
    "40123456789012",
    "USD",
    "autocomplete",
    "cc-exp-year",
    "2027",
    "data-private",
    "private prose",
  ];
  const protection = pageProtection({
    strings,
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8],
          parentIndex: [-1, 0, 0, 0, 3, 4, 0, 6],
          nodeName: [1, 2, 2, 3, 4, 5, 1, 5],
          nodeValue: [-1, -1, -1, -1, -1, 16, -1, 18],
          attributes: [[], [7, 8, 9, 10], [7, 8, 9, 11], [14, 15], [], [], [17, 6], []],
          inputValue: { index: [1, 2], value: [12, 13] },
          textValue: { index: [3], value: [16] },
        },
      },
    ],
  });
  expect(protection.payment).toBe(true);
  expect(protection.values).toEqual([]);
  expect(protection.nodes.get(protectedNodeKey("frame-a", 2))).toBe("private");
  expect(protection.nodes.get(protectedNodeKey("frame-a", 6))).toBe("payment");
  expect(protection.nodes.get(protectedNodeKey("frame-a", 8))).toBe("private");
  const browserPolicy = new Function(
    `return (${SENSITIVE_FIELD_REASON_SOURCE})`,
  )() as typeof sensitiveFieldReason;
  for (const attrs of [
    { type: "hidden" },
    { autocomplete: "cc-exp-year" },
    { "data-private": "" },
  ]) {
    expect(browserPolicy("input", attrs, false, "remember")).toBeNull();
    expect(sensitiveFieldReason("input", attrs, false, "remember")).toBeNull();
  }
});

test("a large snapshot retains its privacy projection without a separate node-count rejection", () => {
  const count = 100_001;
  const protection = pageProtection({
    strings: ["frame-a", "DIV", ""],
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: Array.from({ length: count }, (_, index) => index + 1),
          parentIndex: [-1, ...Array(count - 1).fill(0)],
          nodeName: Array(count).fill(1),
          nodeValue: Array(count).fill(-1),
          attributes: Array.from({ length: count }, () => []),
        },
      },
    ],
  });
  expect(protection.payment).toBe(false);
  expect(protection.nodes.size).toBe(0);
});

test("a named payment wrapper cannot make its expiry options or postal field permanent secrets", () => {
  const protection = pageProtection({
    strings: [
      "frame-a",
      "DIV",
      "SELECT",
      "OPTION",
      "#text",
      "INPUT",
      "",
      "id",
      "credit-card",
      "autocomplete",
      "cc-exp-year",
      "2027",
      "name",
      "postal",
      "0150",
    ],
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3, 4, 5],
          parentIndex: [-1, 0, 1, 2, 0],
          nodeName: [1, 2, 3, 4, 5],
          nodeValue: [-1, -1, -1, 11, -1],
          attributes: [[7, 8], [9, 10], [], [], [12, 13]],
          inputValue: { index: [4], value: [14] },
          textValue: { index: [1], value: [11] },
        },
      },
    ],
  });
  expect(protection.payment).toBe(true);
  expect(protection.values).toEqual([]);
  expect(protection.nodes.get(protectedNodeKey("frame-a", 5))).toBe("payment");
  expect(sensitiveFieldReason("div", { id: "credit-card" }, false, "remember")).toBeNull();
});

test("an actual contenteditable card field remembers its own complete text, not nested form values", () => {
  const protection = pageProtection({
    strings: [
      "frame-a",
      "DIV",
      "SPAN",
      "#text",
      "INPUT",
      "",
      "id",
      "card-number",
      "contenteditable",
      "true",
      "4000 0000 ",
      "0000 0002",
      "name",
      "postal",
      "0150",
    ],
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3, 4, 5],
          parentIndex: [-1, 0, 1, 0, 0],
          nodeName: [1, 2, 3, 3, 4],
          nodeValue: [-1, -1, 10, 11, -1],
          attributes: [[6, 7, 8, 9], [], [], [], [12, 13]],
          inputValue: { index: [4], value: [14] },
        },
      },
    ],
  });
  expect(protection.values).toEqual(["4000 0000 0000 0002"]);
});

test.each([
  null,
  {},
  { strings: [], documents: [{}] },
  { strings: [], documents: [{ frameId: 2, nodes: {} }] },
])("invalid snapshot withholds output rather than assuming no protected fields", (snapshot) => {
  expect(() => pageProtection(snapshot)).toThrow();
});
