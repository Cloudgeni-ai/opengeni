import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { AreaChart } from "./charts";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }) as MediaQueryList) as typeof window.matchMedia;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("AreaChart", () => {
  test("renders an explicit empty state instead of building invalid SVG paths", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={[]}
            series={[{ id: "x", label: "X", values: [], className: "text-brand" }]}
          />,
        );
      });
      expect(container.textContent).toContain("No usage in this window.");
      expect(container.querySelector("svg")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("bounds visible x-axis labels for long YTD ranges while retaining all data points", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const labels = Array.from({ length: 180 }, (_, index) => `day-${index + 1}`);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={labels}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: labels.map((_, index) => index + 1),
                className: "text-brand",
              },
            ]}
          />,
        );
      });
      expect(container.querySelectorAll("circle")).toHaveLength(180);
      expect(container.querySelectorAll("button").length).toBeLessThanOrEqual(8);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
