import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

import { CreatorMonogram } from "@/components/creator-monogram";

import {
  RailTrailingMetadata,
  SessionRowHoverDetails,
  SessionRowContent,
  sessionRowAccessibleName,
} from "./session-row-content";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const neutral = { kind: "neutral", count: 1, total: 1, label: "Idle" } as const;
const active = { kind: "active", count: 1, total: 1, label: "Running" } as const;

const human = { kind: "subject", subjectId: "user:bendik", label: "Bendik Nyheim" } as const;
const service = { kind: "service", subjectId: "scheduled-task", label: "Scheduled task" } as const;
const legacy = { kind: "subject", subjectId: "unattributed-legacy" } as const;

function parse(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

describe("rail creator monogram", () => {
  test("a standalone monogram keeps its native fallback title", () => {
    const host = parse(renderToStaticMarkup(<CreatorMonogram createdBy={human} />));

    expect(host.querySelector("[data-creator-monogram]")?.getAttribute("title")).toBe(
      "Bendik Nyheim",
    );
  });

  test("a root row shows its human creator's monogram before the status dot", () => {
    const host = parse(
      renderToStaticMarkup(
        <RailTrailingMetadata summary={active} relativeTime="3h" creator={human} />,
      ),
    );

    const monogram = host.querySelector("[data-creator-monogram]");
    expect(monogram?.textContent).toBe("BN");
    expect(monogram?.getAttribute("title")).toBeNull();
    expect(monogram?.getAttribute("aria-hidden")).toBe("true");
    expect(monogram?.getAttribute("style")).toContain("oklch(0.45 0.11 ");
    expect(monogram?.className).toContain("size-4");
    expect(monogram?.className).toContain("text-[8px] font-semibold leading-none text-white/90");
    // Monogram, then the status dot, then the relative time.
    const metadata = host.querySelector("[data-session-row-metadata]")!;
    expect([...metadata.children].indexOf(monogram!)).toBe(0);
    expect(metadata.children[2]?.textContent).toBe("3h");
  });

  test("falls back to the subject id when a creator has no label", () => {
    const host = parse(
      renderToStaticMarkup(
        <RailTrailingMetadata
          summary={neutral}
          relativeTime="3h"
          creator={{ kind: "subject", subjectId: "user:iuliia" }}
        />,
      ),
    );

    const monogram = host.querySelector("[data-creator-monogram]");
    expect(monogram?.textContent).toBe("IU");
    expect(monogram?.getAttribute("title")).toBeNull();
  });

  test("renders a creator-only metadata block when a row has nothing else", () => {
    const host = parse(
      renderToStaticMarkup(<RailTrailingMetadata summary={neutral} creator={human} />),
    );

    expect(host.querySelector("[data-session-row-metadata]")).not.toBeNull();
    expect(host.querySelector("[data-creator-monogram]")?.textContent).toBe("BN");
  });

  test.each([
    ["a child row", null],
    ["a service creator", service],
    ["an unattributed legacy creator", legacy],
  ])("reserves no monogram slot for %s", (_name, creator) => {
    const host = parse(
      renderToStaticMarkup(
        <RailTrailingMetadata summary={active} relativeTime="3h" creator={creator} />,
      ),
    );

    const metadata = host.querySelector("[data-session-row-metadata]")!;
    expect(metadata.querySelector("[data-creator-monogram]")).toBeNull();
    // No spacer and no placeholder: the block holds exactly the status marker
    // and the time, so a row without a monogram keeps today's full title width.
    expect(metadata.children.length).toBe(2);
    expect(metadata.innerHTML).not.toContain("min-w-4");
  });

  test("a chip-less row's metadata container keeps its exact layout classes", () => {
    const host = parse(
      renderToStaticMarkup(<RailTrailingMetadata summary={active} relativeTime="3h" />),
    );

    // Frozen on purpose. Any unconditional padding, width, margin, or gap added
    // here silently shrinks the title column of every chip-less row, which is
    // exactly the regression the "no reserved slot" rule forbids. Update this
    // string only when the change is meant to move every row.
    expect(host.querySelector("[data-session-row-metadata]")!.className).toBe(
      "inline-flex shrink-0 items-center justify-end gap-1",
    );
  });

  test("the chip leads the block and never splits a waiting duration from its dot", () => {
    const host = parse(
      renderToStaticMarkup(
        <RailTrailingMetadata
          summary={{
            kind: "needs_attention",
            count: 1,
            total: 1,
            label: "1 needs you · 10h",
            attentionSince: new Date(Date.now() - 10 * 3_600_000).toISOString(),
          }}
          relativeTime="3h"
          creator={human}
        />,
      ),
    );

    const metadata = host.querySelector("[data-session-row-metadata]")!;
    expect([...metadata.children].map((child) => child.textContent)).toEqual([
      "BN",
      "10h",
      "",
      "3h",
    ]);
  });
});

describe("SessionRowHoverDetails", () => {
  test("shows the full title, creator, age, and exact sub-agent count without row status copy", () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverDetails
        title="Diagnose staging availability error with the complete title"
        createdAt={new Date(Date.now() - 13 * 3_600_000).toISOString()}
        createdBy={human}
        descendantCount={3}
        descendantCountTruncated={false}
      />,
    );

    expect(markup).toContain("Diagnose staging availability error with the complete title");
    expect(markup).toContain("13h ago");
    expect(markup).toContain("Created by Bendik Nyheim");
    expect(markup).toContain("3 sub-agents");
    expect(markup).not.toContain("Idle");
    expect(markup).not.toContain("Read");
  });

  test("preserves lower-bound counts and names service-created sessions", () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverDetails
        title="Nightly sweep"
        createdAt={new Date(Date.now() - 60_000).toISOString()}
        createdBy={service}
        descendantCount={1000}
        descendantCountTruncated
      />,
    );

    expect(markup).toContain("Created by Scheduled task");
    expect(markup).toContain("1,000+ sub-agents");
  });
});

describe("sessionRowAccessibleName", () => {
  // `aria-label` replaces name-from-content, so this string - not the chip and
  // not the sr-only span - is what a screen reader actually announces.
  const base = {
    title: "Ship the rail",
    stateLabel: "Idle",
    pinned: false,
    statusLabel: "Idle",
  } as const;

  test("a root row announces its creator", () => {
    expect(sessionRowAccessibleName({ ...base, creator: human })).toBe(
      "Open Ship the rail. Idle. Idle. Created by Bendik Nyheim",
    );
  });

  test("a child row announces no creator", () => {
    const asChild = sessionRowAccessibleName({ ...base, creator: null });

    expect(asChild).toBe("Open Ship the rail. Idle. Idle");
    expect(asChild).not.toContain("Created by");
  });

  test.each([
    ["a service creator", service],
    ["an unattributed legacy creator", legacy],
  ])("announces no creator for %s, matching the chip it does not show", (_name, creator) => {
    expect(sessionRowAccessibleName({ ...base, creator })).not.toContain("Created by");
  });

  test("keeps pinned and spawned facts ahead of the creator", () => {
    expect(
      sessionRowAccessibleName({
        ...base,
        pinned: true,
        statusLabel: "1 needs you",
        spawnedLabel: "3 spawned",
        creator: human,
      }),
    ).toBe("Open Ship the rail. Idle. Pinned. 1 needs you. 3 spawned. Created by Bendik Nyheim");
  });
});

describe("SessionRowContent", () => {
  function srOnly(markup: string): string {
    return parse(markup).querySelector(".sr-only")?.textContent ?? "";
  }

  test.each([
    ["a root row", human],
    ["a child row", null],
    ["a service-created root", service],
  ])("leaves the sr-only state line untouched for %s", (_name, creator) => {
    const markup = renderToStaticMarkup(
      <SessionRowContent
        title="Ship the rail"
        stateLabel="Idle"
        mobile={false}
        summary={neutral}
        relativeTime="3h"
        creator={creator}
      />,
    );

    // The creator belongs to the row's accessible name, which `aria-label`
    // owns. Duplicating it here would be a second, silently inert source.
    expect(srOnly(markup)).toBe("Idle. ");
  });

  test.each([
    ["a service creator", service],
    ["an unattributed legacy creator", legacy],
  ])("renders no chip for %s", (_name, creator) => {
    const markup = renderToStaticMarkup(
      <SessionRowContent
        title="Nightly sweep"
        stateLabel="Idle"
        mobile={false}
        summary={neutral}
        relativeTime="3h"
        creator={creator}
      />,
    );

    expect(markup).not.toContain("data-creator-monogram");
  });

  test("the title column keeps its dynamic width whether or not a chip is present", () => {
    const withChip = parse(
      renderToStaticMarkup(
        <SessionRowContent
          title="Ship the rail"
          stateLabel="Idle"
          mobile={false}
          summary={neutral}
          relativeTime="3h"
          creator={human}
        />,
      ),
    );
    const withoutChip = parse(
      renderToStaticMarkup(
        <SessionRowContent
          title="Ship the rail"
          stateLabel="Idle"
          mobile={false}
          summary={neutral}
          relativeTime="3h"
          creator={null}
        />,
      ),
    );

    // The title stays min-w-0 flex-1 and the metadata stays shrink-0, so the
    // chip simply takes width from the title instead of a reserved slot.
    for (const host of [withChip, withoutChip]) {
      expect(host.querySelector("[data-session-row-title]")?.parentElement?.className).toContain(
        "min-w-0 flex-1",
      );
      expect(host.querySelector("[data-session-row-metadata]")?.className).toContain("shrink-0");
    }
  });

  test("the mobile row keeps the monogram beside its stacked metadata line", () => {
    const markup = renderToStaticMarkup(
      <SessionRowContent
        title="Ship the rail"
        stateLabel="Running"
        mobile
        summary={neutral}
        creator={human}
      />,
    );

    expect(markup).toContain("data-creator-monogram");
    expect(srOnly(markup)).toBe("Running. ");
  });
});
