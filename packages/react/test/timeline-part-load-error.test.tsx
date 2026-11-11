import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { ActivityItem } from "../src/timeline/types";
import type { RenderedComponent } from "./render-hook";

// Lazy parts inside timeline items whose code fails to download, as when their
// chunk request fails. The mocked module yields the browser's download error
// where the part would render, which reaches the same boundaries as a failed
// import and also holds when another file in the process loaded it first.
const notDownloaded = (name: string) => () => ({
  default: function NotDownloaded(): never {
    throw new TypeError(
      `Failed to fetch dynamically imported module: https://app.example.test/assets/${name}-4f1.js`,
    );
  },
});
const PLATFORM_ROW = "../src/timeline/platform-activity-row";
// Copies of the real modules, put back afterwards for any later file in the
// same process (CI runs each file alone).
const realPlatformRow = { ...(await import(PLATFORM_ROW)) };
mock.module(PLATFORM_ROW, notDownloaded("platform-activity-row"));
afterAll(() => {
  mock.module(PLATFORM_ROW, () => realPlatformRow);
});

const { ActivityRail } = await import("../src/timeline/activity-rail");
const { flush, registerDom, renderComponent } = await import("./render-hook");

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

describe("a work row whose code didn't download", () => {
  test("gives way to a Reload notice while the rest of the rail stays", async () => {
    const items: ActivityItem[] = [
      {
        kind: "reasoning",
        id: "thought",
        turnId: "turn-1",
        text: "Considering options",
        streaming: false,
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "tool-call",
        id: "tool",
        turnId: "turn-1",
        callId: "call-tool",
        name: "exec_command",
        status: "complete",
        occurredAt: "2026-01-01T00:00:01.000Z",
        arguments: { command: "echo rail-still-here" },
        output: undefined,
        raw: undefined,
      },
    ];
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      mounted = await renderComponent(<ActivityRail items={items} bare />);
      await flush();
      await flush();
    } finally {
      quiet.mockRestore();
    }
    const container = mounted.container;
    expect(container.querySelector('[data-og-item="tool"]')).not.toBeNull();
    const thought = container.querySelector('[data-og-item="thought"]');
    expect(thought?.querySelector('[data-og-load-failure="inline"]')?.textContent).toBe(
      "This part didn't load.Reload",
    );
    expect(container.querySelectorAll("[data-og-load-failure]")).toHaveLength(1);
  });
});
