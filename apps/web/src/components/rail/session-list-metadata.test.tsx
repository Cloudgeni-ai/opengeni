import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ActiveWorkMark, RailTrailingMetadata } from "./session-row-content";

const neutral = { kind: "neutral", count: 1, total: 1, label: "Idle" } as const;
const active = { kind: "active", count: 1, total: 1, label: "Running" } as const;
const activeWork = {
  kind: "active_work",
  count: 1,
  total: 1,
  label: "1 actively working",
} as const;

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

  test("runs the working spinner at 75% of its prior speed", () => {
    const markup = renderToStaticMarkup(<RailTrailingMetadata summary={active} />);

    expect(markup).toContain('style="animation-duration:1.333333s"');
    expect(markup).toContain("motion-reduce:animate-none");
  });

  test("reserves no trailing rail width when a row has no metadata", () => {
    expect(renderToStaticMarkup(<RailTrailingMetadata summary={neutral} />)).toBe("");
  });

  test("renders the approved two-cut active-work marker", () => {
    const markup = renderToStaticMarkup(<RailTrailingMetadata summary={activeWork} />);

    expect(markup).toContain("<mask");
    expect(markup).toContain('stroke-width="21"');
    expect(markup).toContain('d="M-8 43 C35 40 71 29 116 16"');
    expect(markup).toContain('d="M-8 86 C35 83 71 72 116 59"');
    expect(markup).not.toContain("repeating-linear-gradient");
  });

  test("scales the same active-work marker for action menus", () => {
    const markup = renderToStaticMarkup(<ActiveWorkMark className="size-4" />);

    expect(markup).toContain("size-4");
    expect(markup).toContain("text-brand");
    expect(markup).toContain('d="M-8 43 C35 40 71 29 116 16"');
    expect(markup).toContain('d="M-8 86 C35 83 71 72 116 59"');
  });

  test("uses the shared active-work marker in both session action menus", async () => {
    const source = await Bun.file(new URL("./session-list.tsx", import.meta.url)).text();

    expect(source.match(/<ActiveWorkMark className="size-4" \/>/g)).toHaveLength(2);
    expect(source).not.toContain("CircleDashedIcon");
  });
});

describe("RailTrailingMetadata waiting duration", () => {
  test("shows how long a needs-you row has waited next to the marker", () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const markup = renderToStaticMarkup(
      <RailTrailingMetadata
        summary={{
          kind: "needs_attention",
          count: 2,
          total: 3,
          label: "2 need you · 10h",
          attentionSince: tenHoursAgo,
        }}
        relativeTime="3h"
      />,
    );
    expect(markup).toContain("data-session-row-waiting");
    expect(markup).toContain(">10h</span>");
    expect(markup).toContain('title="2 need you · 10h"');
  });

  test("renders no waiting duration without a server timestamp", () => {
    const markup = renderToStaticMarkup(
      <RailTrailingMetadata
        summary={{ kind: "needs_attention", count: 1, total: 1, label: "1 needs you" }}
      />,
    );
    expect(markup).not.toContain("data-session-row-waiting");
  });
});
