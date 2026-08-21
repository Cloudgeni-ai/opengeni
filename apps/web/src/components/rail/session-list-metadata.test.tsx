import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RailTrailingMetadata } from "./session-row-content";

const neutral = { kind: "neutral", count: 1, total: 1, label: "Idle" } as const;
const active = { kind: "active", count: 1, total: 1, label: "Running" } as const;

describe("RailTrailingMetadata", () => {
  test.each(["1 Aug", "12 Aug", "now", "30m", "3h"])(
    "keeps %s on one stable metadata line",
    (relativeTime) => {
      const markup = renderToStaticMarkup(
        <RailTrailingMetadata summary={neutral} relativeTime={relativeTime} />,
      );

      expect(markup).toContain("data-session-row-metadata");
      expect(markup).toContain("min-w-9 shrink-0 whitespace-nowrap");
      expect(markup).toContain(`>${relativeTime}</span>`);
      expect(markup).not.toContain("w-[4.375rem]");
    },
  );

  test("renders only status, schedule, and date metadata that actually exists", () => {
    const markup = renderToStaticMarkup(
      <RailTrailingMetadata summary={active} scheduled relativeTime="12 Aug" />,
    );

    expect(markup).toContain("Scheduled task");
    expect(markup).toContain("Running");
    expect(markup).toContain(">12 Aug</span>");
  });

  test("reserves no trailing rail width when a row has no metadata", () => {
    expect(renderToStaticMarkup(<RailTrailingMetadata summary={neutral} />)).toBe("");
  });
});
