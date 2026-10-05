import { describe, expect, test } from "bun:test";
import { omitStructuredContentTextDuplicates, type AttemptToolResult } from "../src";

const structured = {
  items: [{ id: 1, title: 'Bug "quoted"', labels: ["a", "b"] }],
  total: 1,
};

describe("omitStructuredContentTextDuplicates", () => {
  test("returns the same object when there is no structuredContent", () => {
    const result: AttemptToolResult = {
      content: [{ type: "text", text: JSON.stringify(structured) }],
    };
    expect(omitStructuredContentTextDuplicates(result)).toBe(result);
  });

  test("drops compact, pretty-printed, and reordered serializations of structuredContent", () => {
    for (const text of [
      JSON.stringify(structured),
      JSON.stringify(structured, null, 2),
      JSON.stringify({ total: 1, items: [{ labels: ["a", "b"], title: 'Bug "quoted"', id: 1 }] }),
    ]) {
      const result: AttemptToolResult = {
        content: [{ type: "text", text }],
        structuredContent: structured,
        _meta: { trace: "t" },
        isError: false,
      };
      expect(omitStructuredContentTextDuplicates(result)).toEqual({
        content: [],
        structuredContent: structured,
        _meta: { trace: "t" },
        isError: false,
      });
    }
  });

  test("keeps the envelope key order so only the duplicate bytes change", () => {
    const result: AttemptToolResult = {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: true,
    };
    expect(JSON.stringify(omitStructuredContentTextDuplicates(result))).toBe(
      JSON.stringify({ content: [], structuredContent: structured, isError: true }),
    );
  });

  test("keeps prose, differing JSON, and annotated text blocks", () => {
    const result: AttemptToolResult = {
      content: [
        { type: "text", text: "Found 1 issue." },
        { type: "text", text: JSON.stringify({ ...structured, total: 2 }) },
        { type: "text", text: JSON.stringify(structured), annotations: { audience: ["user"] } },
        { type: "text", text: JSON.stringify(structured) },
      ],
      structuredContent: structured,
    };
    expect(omitStructuredContentTextDuplicates(result).content).toEqual(result.content.slice(0, 3));
  });

  test("keeps non-text content blocks", () => {
    const image = { type: "image" as const, data: "/9j/2Q==", mimeType: "image/jpeg" };
    const link = { type: "resource_link" as const, uri: "file:///a.txt", name: "a.txt" };
    const result: AttemptToolResult = {
      content: [{ type: "text", text: JSON.stringify(structured) }, image, link],
      structuredContent: structured,
    };
    expect(omitStructuredContentTextDuplicates(result).content).toEqual([image, link]);
  });

  test("compares numbers by IEEE-754 value", () => {
    const result: AttemptToolResult = {
      content: [{ type: "text", text: '{"total":1.0,"ratio":0.50}' }],
      structuredContent: { total: 1, ratio: 0.5 },
    };
    expect(omitStructuredContentTextDuplicates(result).content).toEqual([]);
  });

  test("keeps text with an unsafe integer even when it equals the compact serialization", () => {
    const structuredContent = JSON.parse('{"id":12345678901234567000}') as NonNullable<
      AttemptToolResult["structuredContent"]
    >;
    const result: AttemptToolResult = {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
    expect(omitStructuredContentTextDuplicates(result)).toBe(result);
  });

  test("keeps text whose integers are more precise than the parsed structuredContent", () => {
    const text = '{"id":12345678901234567891}';
    const result: AttemptToolResult = {
      content: [{ type: "text", text }],
      structuredContent: JSON.parse(text) as NonNullable<AttemptToolResult["structuredContent"]>,
    };
    expect(omitStructuredContentTextDuplicates(result)).toBe(result);
  });

  test("measures a realistic issue-search result", () => {
    const issues = Array.from({ length: 25 }, (_, index) => ({
      id: 4_100_000 + index,
      identifier: `ENG-${1200 + index}`,
      title: `Checkout fails with "card_declined" after retry #${index}`,
      state: index % 3 === 0 ? "In Progress" : "Todo",
      priority: (index % 4) + 1,
      assignee: { id: `user-${index % 5}`, name: `Engineer ${index % 5}` },
      labels: ["bug", "payments", index % 2 === 0 ? "customer-reported" : "regression"],
      url: `https://linear.app/acme/issue/ENG-${1200 + index}`,
      createdAt: "2026-09-21T08:15:00.000Z",
      updatedAt: "2026-10-01T16:42:10.000Z",
      description:
        "Customers on the EU region see a declined card after the payment intent is retried.\n" +
        "Steps: 1) add item 2) pay with 3DS card 3) cancel challenge 4) retry.",
    }));
    const structuredContent = { issues, pageInfo: { hasNextPage: true, endCursor: "c25" } };
    const result: AttemptToolResult = {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
    const before = Buffer.byteLength(JSON.stringify(result));
    const after = Buffer.byteLength(JSON.stringify(omitStructuredContentTextDuplicates(result)));
    expect(after).toBeLessThan(before / 2);
  });
});
