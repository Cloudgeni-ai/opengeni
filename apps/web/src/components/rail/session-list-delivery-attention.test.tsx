import { describe, expect, test } from "bun:test";
import { createElement } from "react";

import { RailTrailingMetadata } from "@/components/rail/session-list";
import type { RailAggregateStatus } from "@/lib/sessions-group";
import { registerDom, renderComponent } from "../../../../../packages/react/test/render-hook";

registerDom();

describe("production session rail delivery attention", () => {
  test("uses the existing compact status position without changing metadata geometry", async () => {
    const failed: RailAggregateStatus = {
      kind: "failed",
      count: 1,
      total: 1,
      label: "1 failed",
    };
    const rendered = await renderComponent(
      createElement(RailTrailingMetadata, {
        summary: failed,
        scheduled: true,
        relativeTime: "2m",
      }),
    );

    const existingOuterClass = rendered.container.firstElementChild?.className;
    const existingStatusClass = rendered.container.querySelector('[title="1 failed"]')?.className;

    const sendFailed: RailAggregateStatus = {
      kind: "send_failed",
      count: 1,
      total: 1,
      label: "1 message not sent",
    };
    await rendered.rerender(
      createElement(RailTrailingMetadata, {
        summary: sendFailed,
        scheduled: true,
        relativeTime: "2m",
      }),
    );

    const outer = rendered.container.firstElementChild;
    const statusSlot = rendered.container.querySelector('[title="1 message not sent"]');
    const icon = statusSlot?.querySelector("svg");

    expect(outer?.className).toBe(existingOuterClass);
    expect(statusSlot?.className).toBe(existingStatusClass);
    expect(statusSlot?.getAttribute("title")).toBe("1 message not sent");
    expect(icon?.classList.contains("text-status-failed")).toBe(true);
    expect(rendered.container.textContent).toBe("2m");

    await rendered.unmount();
  });
});
