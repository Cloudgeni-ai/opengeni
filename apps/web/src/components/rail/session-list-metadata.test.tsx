import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RailTrailingMetadata } from "./session-list";

const neutral = { kind: "neutral", count: 1, total: 1, label: "Idle" } as const;
const active = { kind: "active", count: 1, total: 1, label: "Running" } as const;

describe("RailTrailingMetadata", () => {
  test.each(["1 Aug", "12 Aug", "now", "30m", "3h"])(
    "keeps %s on one stable metadata line",
    (relativeTime) => {
      const markup = renderToStaticMarkup(
        <RailTrailingMetadata summary={neutral} relativeTime={relativeTime} />,
      );

      expect(markup).toContain("grid-cols-[0.875rem_0.75rem_2.25rem]");
      expect(markup).toContain("shrink-0 whitespace-nowrap");
      expect(markup).toContain(`>${relativeTime}</span>`);
    },
  );

  test("keeps status and scheduled columns separate from the fixed date column", () => {
    const markup = renderToStaticMarkup(
      <RailTrailingMetadata summary={active} scheduled relativeTime="12 Aug" />,
    );

    expect(markup).toContain("Scheduled task");
    expect(markup).toContain("Running");
    expect(markup).toContain(">12 Aug</span>");
  });
});
