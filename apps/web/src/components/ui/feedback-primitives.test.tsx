import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DisabledReason } from "./disabled-reason";
import { ErrorMessage } from "./error-message";
import { InlineHelp } from "./inline-help";
import { sparklinePoints, StatTile } from "./stat-tile";

describe("DisabledReason", () => {
  test("keeps the control focusable and links the reason", () => {
    const html = renderToStaticMarkup(
      <DisabledReason reason="Only organization admins can invite people.">
        <button type="button" disabled>
          Invite people
        </button>
      </DisabledReason>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("Only organization admins can invite people.");
  });

  test("keeps an existing description", () => {
    const html = renderToStaticMarkup(
      <DisabledReason reason="Resume the schedule first.">
        <button type="button" aria-describedby="hint">
          Run now
        </button>
      </DisabledReason>,
    );
    expect(html).toMatch(/aria-describedby="hint [^"]+"/);
  });

  test("renders the control untouched when enabled", () => {
    const html = renderToStaticMarkup(
      <DisabledReason reason="Not shown" disabled={false}>
        <button type="button">Redeem</button>
      </DisabledReason>,
    );
    expect(html).toBe('<button type="button">Redeem</button>');
  });
});

describe("ErrorMessage", () => {
  const reference = "4b1d7e2a-93c5-4f08-b6de-2a91c0f7e5d3";

  test("keeps the reference out of the message and in Technical details", () => {
    const html = renderToStaticMarkup(
      <ErrorMessage title="Couldn't load this connection's tools." reference={reference} />,
    );
    const [message] = html.split("Technical details");
    expect(message).not.toContain(reference);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<dl[^>]*hidden=""/);
    expect(html).toContain(reference);
    expect(html).toContain('aria-label="Copy reference"');
  });

  test("only announces when asked", () => {
    expect(renderToStaticMarkup(<ErrorMessage title="Couldn't save." />)).not.toContain("role=");
    expect(renderToStaticMarkup(<ErrorMessage title="Couldn't save." announce />)).toContain(
      'role="alert"',
    );
  });

  test("has no Technical details without facts", () => {
    expect(
      renderToStaticMarkup(<ErrorMessage variant="inline" title="Couldn't save." />),
    ).not.toContain("Technical details");
  });
});

describe("StatTile", () => {
  test("sparkline points fill the box, flat series sit in the middle", () => {
    expect(sparklinePoints([])).toBe("");
    expect(sparklinePoints([1, 3])).toBe("0,30 100,2");
    expect(sparklinePoints([5, 5, 5])).toBe("0,16 50,16 100,16");
    expect(sparklinePoints([7])).toBe("50,16");
  });

  test("the trend is spoken, not only drawn", () => {
    const html = renderToStaticMarkup(
      <StatTile
        label="Failed runs"
        value="3"
        delta={{
          value: "-2",
          trend: "down",
          sentiment: "positive",
          comparison: "vs previous 7 days",
        }}
      />,
    );
    expect(html).toContain('<span class="sr-only">Down </span>');
    expect(html).toContain("text-status-idle");
    expect(html).toContain("vs previous 7 days");
  });

  test("empty and loading states replace the value", () => {
    expect(renderToStaticMarkup(<StatTile label="Failed runs" empty="No runs yet" />)).toContain(
      "No runs yet",
    );
    const loading = renderToStaticMarkup(<StatTile label="Sessions" value="1,284" loading />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("1,284");
  });
});

describe("InlineHelp", () => {
  test("is one muted line", () => {
    const html = renderToStaticMarkup(<InlineHelp>People come from Acme Robotics.</InlineHelp>);
    expect(html).toMatch(/^<p /);
    expect(html).toContain("text-fg-muted");
    expect(html).not.toContain("<svg");
  });
});
