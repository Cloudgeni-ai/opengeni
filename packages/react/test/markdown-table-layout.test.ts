import { describe, expect, test } from "bun:test";
import { markdownTableWidth } from "../src/components/markdown-table-layout";

describe("chat table available width", () => {
  const desktop = {
    columnLeft: 336,
    columnWidth: 768,
    contentLeft: 24,
    contentRight: 1416,
  };

  test("keeps small tables at prose width", () => {
    expect(markdownTableWidth({ ...desktop, preferredWidth: 420 })).toBe(768);
  });

  test("uses only the width the table needs beyond prose", () => {
    expect(markdownTableWidth({ ...desktop, preferredWidth: 1100 })).toBe(1100);
  });

  test("caps oversized tables at the panel's padded content edges", () => {
    expect(markdownTableWidth({ ...desktop, preferredWidth: 1900 })).toBe(1392);
  });

  test("uses the nearer panel edge when the column is not centered", () => {
    expect(markdownTableWidth({ ...desktop, contentLeft: 200, preferredWidth: 1900 })).toBe(1040);
  });

  test("does not borrow viewport space for a narrow embedded panel", () => {
    expect(
      markdownTableWidth({
        columnLeft: 724,
        columnWidth: 452,
        contentLeft: 724,
        contentRight: 1176,
        preferredWidth: 1100,
      }),
    ).toBe(452);
  });

  test("recalculates smaller preferred widths without retaining the last expansion", () => {
    expect(
      [1100, 1900, 400].map((preferredWidth) => markdownTableWidth({ ...desktop, preferredWidth })),
    ).toEqual([1100, 1392, 768]);
  });
});
