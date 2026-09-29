import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PRODUCT_STATUS_KEYS,
  PRODUCT_STATUSES,
  resolveStatus,
  StatusBadge,
  StatusBadgeSkeleton,
} from "./status-badge";
import { StatusDot } from "./status-dot";

describe("status vocabulary", () => {
  test("labels are sentence case and never raw enums", () => {
    for (const key of PRODUCT_STATUS_KEYS) {
      const { label } = PRODUCT_STATUSES[key];
      expect(label).not.toContain("_");
      expect(label[0]).toBe(label[0]!.toUpperCase());
      // Every word after the first is lower case: "Needs reconnect", not "Needs Reconnect".
      for (const word of label.split(" ").slice(1)) {
        expect(word).toBe(word.toLowerCase());
      }
    }
  });

  test("one tone per meaning", () => {
    expect(PRODUCT_STATUSES.connected.tone).toBe("success");
    expect(PRODUCT_STATUSES.needs_reconnect.tone).toBe("attention");
    expect(PRODUCT_STATUSES.running.tone).toBe("progress");
    expect(PRODUCT_STATUSES.failed.tone).toBe("danger");
    expect(PRODUCT_STATUSES.expired.tone).toBe("danger");
    for (const key of ["paused", "revoked", "suspended", "unavailable", "off"] as const) {
      expect(PRODUCT_STATUSES[key].tone).toBe("neutral");
    }
  });

  test("an explicit tone wins, and a custom label defaults to neutral", () => {
    expect(resolveStatus("paused", "attention").tone).toBe("attention");
    expect(resolveStatus(undefined, undefined)).toEqual({
      label: null,
      tone: "neutral",
      meta: null,
    });
  });
});

describe("StatusBadge", () => {
  test("renders a dot and the label, never color alone", () => {
    const html = renderToStaticMarkup(<StatusBadge status="needs_reconnect" />);
    expect(html).toContain("Needs reconnect");
    expect(html).toContain('data-tone="attention"');
    expect(html).toContain("bg-status-waiting");
    expect(html).toContain('data-variant="outline"');
  });

  test("children override the label but keep the status tone", () => {
    const html = renderToStaticMarkup(
      <StatusBadge status="invited">Invited · expires in 5 days</StatusBadge>,
    );
    expect(html).toContain("Invited · expires in 5 days");
    expect(html).toContain('data-tone="neutral"');
  });

  test("a reason makes the badge focusable and readable", () => {
    const reason = "GitHub isn't available on this OpenGeni server yet.";
    const html = renderToStaticMarkup(<StatusBadge status="unavailable" reason={reason} />);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain(reason.replace("'", "&#x27;"));
  });

  test("without a reason it is not a tab stop", () => {
    expect(renderToStaticMarkup(<StatusBadge status="connected" />)).not.toContain("tabindex");
  });

  test("each look has its own chrome", () => {
    expect(renderToStaticMarkup(<StatusBadge status="failed" variant="dot" />)).not.toContain(
      "rounded-full border",
    );
    const tinted = renderToStaticMarkup(<StatusBadge status="failed" variant="tinted" />);
    expect(tinted).toContain("bg-danger/10");
    expect(tinted).toContain("text-danger");
  });

  test("live statuses pulse, others don't", () => {
    expect(renderToStaticMarkup(<StatusBadge status="running" />)).toContain("animate-pulse");
    expect(renderToStaticMarkup(<StatusBadge status="connected" />)).not.toContain("animate-pulse");
  });

  test("the skeleton announces loading", () => {
    expect(renderToStaticMarkup(<StatusBadgeSkeleton />)).toContain('aria-label="Loading status"');
  });
});

describe("StatusDot", () => {
  test("keeps lifecycle tones and adds semantic ones", () => {
    expect(renderToStaticMarkup(<StatusDot tone="idle" />)).toContain("bg-status-idle");
    expect(renderToStaticMarkup(<StatusDot tone="danger" />)).toContain("bg-danger");
    expect(renderToStaticMarkup(<StatusDot tone="neutral" size="sm" />)).toContain("size-1.5");
    expect(renderToStaticMarkup(<StatusDot tone="idle" />)).toContain("size-2");
  });
});
