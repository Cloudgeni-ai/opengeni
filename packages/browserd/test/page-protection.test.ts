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
  expect(protection.values).toEqual(["private note", "731"]);
  expect(protection.nodes.get(protectedNodeKey("frame-a", 3))).toBe("private");
});

test.each([
  null,
  {},
  { strings: [], documents: [{}] },
  { strings: [], documents: [{ frameId: 2, nodes: {} }] },
])("invalid snapshot withholds output rather than assuming no protected fields", (snapshot) => {
  expect(() => pageProtection(snapshot)).toThrow();
});
