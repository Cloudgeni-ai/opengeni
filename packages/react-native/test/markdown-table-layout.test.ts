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

test("a wide table of short cells wraps them to their longest word before scrolling", () => {
  const columns = tableColumns(PLANS);
  const { widths, scrolls } = tableLayout(columns, 358);
  expect(scrolls).toBe(true);
  // Each column is as narrow as its longest word ("business", "Negotiated").
  expect(widths).toEqual(columns.map((column) => column.min));
  expect(visibleColumns(widths, 358)).toBeGreaterThanOrEqual(4);
});

test("a column of sentences keeps reading as lines on a phone", () => {
  const rows = [
    ["Option", "What it is", "Budget for two"],
    [
      "Coastal hotel weekend",
      "One night at a seaside hotel with dinner, breakfast and a walk along the shore before heading home.",
      "5,000–7,000 NOK",
    ],
    [
      "City break",
      "Friday to Sunday in a modest central hotel, exploring the old town and waterfront, with a set-menu dinner.",
      "6,000–9,000 NOK, two nights",
    ],
  ];
  const columns = tableColumns(rows);
  const { widths, scrolls } = tableLayout(columns, 358);
  // Squeezing all three into 358 pt would leave the description a few words a
  // line; it keeps a readable measure and the table scrolls instead.
  expect(scrolls).toBe(true);
  expect(widths[1]).toBeGreaterThanOrEqual(220);
  // The short columns still wrap to their longest word.
  expect(widths[0]).toBe(columns[0]!.min);
  expect(widths[2]).toBe(columns[2]!.min);
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
