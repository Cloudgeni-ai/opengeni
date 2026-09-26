import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  clampPercent,
  resetPhrase,
  usageAccessibleText,
  usageLevel,
  usageValueText,
  UsageMeter,
  UsageMeterGroup,
} from "./usage-meter";

describe("usage levels", () => {
  test("a status tone only below 10% left", () => {
    expect(usageLevel(22)).toBe("healthy");
    expect(usageLevel(10)).toBe("healthy");
    expect(usageLevel(9.9)).toBe("low");
    expect(usageLevel(8)).toBe("low");
    expect(usageLevel(0)).toBe("exhausted");
    expect(usageLevel(-3)).toBe("exhausted");
  });

  test("a missing reading is unknown, never zero", () => {
    expect(usageLevel(null)).toBe("unknown");
    expect(usageLevel(undefined)).toBe("unknown");
    expect(usageLevel(Number.NaN)).toBe("unknown");
    expect(usageValueText(null)).toBe("Not reported yet");
  });

  test("machines measure what's used, so the tone flips near full", () => {
    expect(usageLevel(32, "used")).toBe("healthy");
    expect(usageLevel(94, "used")).toBe("low");
    expect(usageLevel(100, "used")).toBe("exhausted");
    expect(usageValueText(32, "used")).toBe("32% used");
  });

  test("values are clamped and rounded, and exhausted says so", () => {
    expect(clampPercent(21.6)).toBe(22);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(usageValueText(21.6)).toBe("22% left");
    expect(usageValueText(0)).toBe("Limit reached");
  });

  test("the accessible text names the window, the value and the reset", () => {
    expect(
      usageAccessibleText({ label: "Weekly", percent: 22, resetsLabel: "Mon 28 Sep, 09:00" }),
    ).toBe("Weekly: 22% left, resets Mon 28 Sep, 09:00");
    expect(usageAccessibleText({ label: "5-hour", percent: 64 })).toBe("5-hour: 64% left");
  });

  test("relative days read lowercase after Resets, dates stay as they are", () => {
    expect(resetPhrase("Today, 17:10")).toBe("today, 17:10");
    expect(resetPhrase("Tomorrow, 09:00")).toBe("tomorrow, 09:00");
    expect(resetPhrase("Mon 28 Sep, 09:00")).toBe("Mon 28 Sep, 09:00");
    expect(usageAccessibleText({ label: "5-hour", percent: 64, resetsLabel: "Today, 17:10" })).toBe(
      "5-hour: 64% left, resets today, 17:10",
    );
    expect(
      renderToStaticMarkup(<UsageMeter label="5-hour" percent={64} resetsLabel="Today, 17:10" />),
    ).toContain("Resets today, 17:10");
  });
});

describe("UsageMeter", () => {
  test("a known reading is a meter with a text value", () => {
    const html = renderToStaticMarkup(
      <UsageMeter label="Weekly" percent={22} resetsLabel="Mon 28 Sep, 09:00" />,
    );
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="22"');
    expect(html).toContain('aria-valuetext="Weekly: 22% left, resets Mon 28 Sep, 09:00"');
    expect(html).toContain("Resets Mon 28 Sep, 09:00");
    expect(html).toContain("width:22%");
  });

  test("an exhausted reading draws no fill and keeps the reset time", () => {
    const html = renderToStaticMarkup(
      <UsageMeter label="Weekly" percent={0} resetsLabel="Mon 28 Sep, 09:00" />,
    );
    expect(html).toContain('data-level="exhausted"');
    expect(html).toContain("Limit reached");
    expect(html).toContain("width:0%");
    expect(html).toContain("Resets Mon 28 Sep, 09:00");
  });

  test("an unknown reading is not announced as a meter", () => {
    const html = renderToStaticMarkup(<UsageMeter label="5-hour" percent={null} />);
    expect(html).not.toContain('role="meter"');
    expect(html).toContain('role="group"');
    expect(html).toContain("Not reported yet");
  });

  test("labels are never abbreviated in any look or density", () => {
    for (const variant of ["bar", "text", "ring"] as const) {
      for (const density of ["full", "compact"] as const) {
        const html = renderToStaticMarkup(
          <UsageMeter label="5-hour" percent={64} variant={variant} density={density} />,
        );
        expect(html).toContain("5-hour");
        expect(html).not.toMatch(/>5h<|>Wk</);
      }
    }
  });

  test("the bar look reads as text in a row: bar in the sheet, text in the row", () => {
    const html = renderToStaticMarkup(
      <UsageMeter label="Weekly" percent={22} variant="bar" density="compact" />,
    );
    expect(html).toContain("22% left");
    expect(html).not.toContain("width:");
    expect(html).toContain('role="meter"');
  });

  test("compact meters are phrasing content, so they fit inside a row's text", () => {
    const html = renderToStaticMarkup(
      <UsageMeterGroup
        windows={[
          { label: "Weekly", percent: 22 },
          { label: "5-hour", percent: 64 },
        ]}
        density="compact"
      />,
    );
    expect(html).not.toContain("<div");
    expect(html).not.toContain("<p");
  });

  test("the group footer shows the check, refresh and a disabled reason", () => {
    const html = renderToStaticMarkup(
      <UsageMeterGroup
        windows={[{ label: "Weekly", percent: 8 }]}
        checked="Checked 4 min ago"
        onRefresh={() => undefined}
        refreshDisabledReason="Reconnect research@acme.dev to check its usage."
      />,
    );
    expect(html).toContain("Checked 4 min ago");
    expect(html).toContain('aria-label="Check usage now"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Reconnect research@acme.dev to check its usage.");
  });
});
