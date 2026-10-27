import { expect, test } from "bun:test";
import { tableColumns, tableLayout } from "../src/timeline/markdown-table-layout";

const PLANS = [
  [
    "Plan",
    "Monthly price",
    "Seats included",
    "Storage",
    "Support",
    "Uptime SLA",
    "Overage per seat",
  ],
  ["Starter", "$0", "3", "5 GB", "Community forum", "None", "Not available"],
  ["Team", "$49", "10", "100 GB", "Email, next business day", "99.5%", "$6"],
  ["Business", "$199", "50", "1 TB", "Chat and email, 4 hours", "99.9%", "$5"],
  ["Enterprise", "Custom", "Unlimited", "Custom", "Dedicated manager", "99.99%", "Negotiated"],
];

/** How many columns start within a phone-width viewport. */
function visibleColumns(widths: number[], viewport: number) {
  let left = 0;
  let count = 0;
  for (const width of widths) {
    if (left + width / 2 > viewport) break;
    left += width;
    count += 1;
  }
  return count;
}

test("a wide table wraps its cells to their longest word before scrolling, as a browser does", () => {
  const columns = tableColumns(PLANS);
  const { widths, scrolls } = tableLayout(columns, 358);
  expect(scrolls).toBe(true);
  // Each column is as narrow as its longest word ("business", "Negotiated").
  expect(widths).toEqual(columns.map((column) => column.min));
  expect(visibleColumns(widths, 358)).toBeGreaterThanOrEqual(4);
});

test("a table that fits when wrapped doesn't scroll and fills the width", () => {
  const rows = PLANS.map((row) => row.slice(0, 4));
  const { widths, scrolls } = tableLayout(tableColumns(rows), 358);
  expect(scrolls).toBe(false);
  expect(Math.round(widths.reduce((sum, width) => sum + width, 0))).toBe(358);
});

test("a narrow table keeps every cell on one line and shares the spare room", () => {
  const rows = [
    ["Plan", "Seats"],
    ["Team", "10"],
  ];
  const columns = tableColumns(rows);
  const { widths, scrolls } = tableLayout(columns, 358);
  expect(scrolls).toBe(false);
  widths.forEach((width, index) => expect(width).toBeGreaterThanOrEqual(columns[index]!.max));
  expect(Math.round(widths.reduce((sum, width) => sum + width, 0))).toBe(358);
});

test("one long word never makes a column wider than the cap", () => {
  const columns = tableColumns([
    ["Link"],
    ["https://example.com/a/very/long/path/that/keeps/going/on"],
  ]);
  expect(columns[0]!.min).toBeLessThanOrEqual(280);
  expect(columns[0]!.max).toBe(280);
});
