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
    ["input", { type: "password" }, false, "password"],
    ["input", { type: "PASSWORD" }, false, "password"],
    ["input", { autocomplete: "current-password" }, false, "password"],
    ["input", { autocomplete: "new-password" }, false, "password"],
    ["input", { autocomplete: "one-time-code" }, false, "password"],
    ["input", { autocomplete: "section-billing cc-number" }, false, "payment"],
    ["input", { autocomplete: "cc-csc" }, false, "payment"],
    ["input", { type: "hidden" }, false, "private"],
    ["span", { "data-private": "" }, false, "private"],
    ["div", { "data-sensitive": "" }, true, "private"],
    ["div", { "data-opengeni-private": "" }, false, "private"],
    // Names, ids, placeholders and labels are never guessed from.
    ["input", { type: "text", name: "password" }, false, null],
    ["input", { "aria-label": "Password" }, false, null],
    ["input", { placeholder: "Passord" }, false, null],
    ["input", { id: "cardNumber" }, false, null],
    ["input", { name: "cvc" }, false, null],
    ["div", { id: "card-number" }, true, null],
    ["input", { name: "username" }, false, null],
  ] as const)("the native and browser policy agree for %s %j", (tag, attrs, editable, reason) => {
    expect(sensitiveFieldReason(tag, attrs, editable)).toBe(reason);
    expect(browserPolicy(tag, attrs, editable)).toBe(reason);
  });
});

test("snapshot protection marks standard fields, inherits into descendants and scopes by frame", () => {
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
    "name",
    "password",
  ];
  const protection = pageProtection({
    strings,
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3, 4],
          parentIndex: [-1, 0, 0, 0],
          nodeName: [1, 2, 3, 2],
          nodeValue: [-1, -1, 9, -1],
          attributes: [[5, 4], [6, 7], [], [10, 11]],
          inputValue: { index: [1], value: [8] },
        },
      },
    ],
  });
  expect(protection).toEqual({
    nodes: new Map([
      [protectedNodeKey("frame-a", 1), "private"],
      [protectedNodeKey("frame-a", 2), "payment"],
      [protectedNodeKey("frame-a", 3), "private"],
      [protectedNodeKey("frame-a", 4), "private"],
    ]),
  });
  expect(protection.nodes.get(protectedNodeKey("frame-b", 2))).toBeUndefined();
});

test("a field named like a password is not protected without standard markup", () => {
  const protection = pageProtection({
    strings: ["frame-a", "INPUT", "name", "password", "LABEL", "#text", "Password"],
    documents: [
      {
        frameId: 0,
        nodes: {
          backendNodeId: [1, 2, 3],
          parentIndex: [-1, -1, 1],
          nodeName: [1, 4, 5],
          nodeValue: [-1, -1, 6],
          attributes: [[2, 3], [], []],
        },
      },
    ],
  });
  expect(protection.nodes.size).toBe(0);
});

test("an invalid snapshot is rejected", () => {
  expect(() => pageProtection({})).toThrow();
  expect(() =>
    pageProtection({ strings: [], documents: [{ frameId: -1, nodes: { backendNodeId: [] } }] }),
  ).toThrow();
});
