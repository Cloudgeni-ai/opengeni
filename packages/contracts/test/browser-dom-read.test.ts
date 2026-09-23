import { expect, test } from "bun:test";
import { BrowserDomReadRequest } from "../src/interaction";

const fences = {
  expectedTargetGeneration: "target-1",
  expectedDocumentGeneration: "document-1",
  expectedFrameId: "frame-1",
};

test("focused DOM reads accept structural selectors but reject secret-value predicates", () => {
  expect(
    BrowserDomReadRequest.safeParse({
      ...fences,
      kind: "count",
      selector: "main > section.card",
    }).success,
  ).toBe(true);
  for (const selector of ['input[value^="s"]', "input:has([value])"]) {
    expect(BrowserDomReadRequest.safeParse({ ...fences, kind: "count", selector }).success).toBe(
      false,
    );
    expect(
      BrowserDomReadRequest.safeParse({
        ...fences,
        kind: "element",
        locator: { kind: "css", selector },
      }).success,
    ).toBe(false);
  }
  for (const locator of [
    { kind: "text", text: "secret prefix" },
    { kind: "role", role: "text", name: "secret prefix" },
    { kind: "label", text: "secret prefix" },
  ]) {
    expect(BrowserDomReadRequest.safeParse({ ...fences, kind: "element", locator }).success).toBe(
      false,
    );
  }
});
