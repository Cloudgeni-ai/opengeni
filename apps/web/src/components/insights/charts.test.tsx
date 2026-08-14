import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { AreaChart, smoothLine } from "./charts";

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
  test("keeps smoothing control points inside long zero runs around a spike", () => {
    const path = smoothLine([
      { x: 0, y: 10 },
      { x: 1, y: 10 },
      { x: 2, y: 10 },
      { x: 3, y: 0 },
      { x: 4, y: 10 },
      { x: 5, y: 10 },
      { x: 6, y: 10 },
    ]);
    const renderedY = [...path.matchAll(/-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g)].map((match) =>
      Number(match[1]),
    );

    expect(Math.min(...renderedY)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...renderedY)).toBeLessThanOrEqual(10);
  });

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

      const slider = container.querySelector('[role="slider"]') as SVGSVGElement;
      expect(slider.getAttribute("aria-valuemax")).toBe("179");
      await act(async () => {
        slider.focus();
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      });
      expect(slider.getAttribute("aria-valuenow")).toBe("179");
      expect(slider.getAttribute("aria-valuetext")).toBe("day-180. Tokens: 180");

      await act(async () => {
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      });
      expect(slider.getAttribute("aria-valuenow")).toBe("178");
      expect(slider.getAttribute("aria-valuetext")).toBe("day-179. Tokens: 179");

      await act(async () => {
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      });
      expect(slider.getAttribute("aria-valuenow")).toBe("0");
      expect(slider.getAttribute("aria-valuetext")).toBe("day-1. Tokens: 1.0");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("clips the active hover band to the chart plotting area", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={["00:00", "01:00", "02:00"]}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: [1, 2, 3],
                className: "text-brand",
              },
            ]}
          />,
        );
      });

      const clipPath = container.querySelector("clipPath");
      const highlight = container.querySelector('[data-chart-plot-highlight="clipped"]');
      expect(clipPath).not.toBeNull();
      expect(highlight?.getAttribute("clip-path")).toBe(`url(#${clipPath?.id})`);
      expect(container.querySelector("svg")?.classList.contains("overflow-hidden")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("uses nearest-point hover cells without translating them a second time", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={["00:00", "01:00", "02:00"]}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: [0, 1, 0],
                className: "text-brand",
              },
            ]}
          />,
        );
      });

      const labels = container.querySelectorAll("button");
      for (const [index, expected] of [
        [0, { x: "36", width: "168" }],
        [1, { x: "204", width: "336" }],
        [2, { x: "540", width: "168" }],
      ] as const) {
        await act(async () => {
          labels[index]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        });

        const band = container.querySelector('[data-chart-hover-band="aligned"]');
        expect(band?.getAttribute("x")).toBe(expected.x);
        expect(band?.getAttribute("width")).toBe(expected.width);
        expect(band?.getAttribute("transform")).toBeNull();
        expect(band?.getAttribute("style")).toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("centers a single bucket while highlighting the full plot", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={["00:00"]}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: [1],
                className: "text-brand",
              },
            ]}
          />,
        );
      });

      await act(async () => {
        container
          .querySelector("button")
          ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });

      const band = container.querySelector('[data-chart-hover-band="aligned"]');
      const activeGuide = [...container.querySelectorAll("svg line")].at(-1);
      expect(band?.getAttribute("x")).toBe("36");
      expect(band?.getAttribute("width")).toBe("672");
      expect(activeGuide?.getAttribute("x1")).toBe("372");
      expect(container.querySelector("circle")?.getAttribute("cx")).toBe("372");
      expect(
        container
          .querySelector('[data-chart-tooltip="aligned"]')
          ?.getAttribute("data-chart-tooltip-position"),
      ).toBe("50");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("exposes point values and hover geometry to keyboard focus", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={["00:00", "01:00", "02:00"]}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: [0, 1, 0],
                className: "text-brand",
              },
            ]}
          />,
        );
      });

      const middleLabel = container.querySelectorAll("button")[1] as HTMLButtonElement;
      expect(middleLabel.getAttribute("aria-label")).toBe("01:00. Tokens: 1.0");

      await act(async () => middleLabel.focus());
      expect(container.querySelector('[data-chart-hover-band="aligned"]')).not.toBeNull();
      expect(container.textContent).toContain("Tokens");
      expect(container.textContent).toContain("1.0");

      await act(async () => middleLabel.blur());
      expect(container.querySelector('[data-chart-hover-band="aligned"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("restores keyboard selection after pointer hover ends", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={["00:00", "01:00", "02:00"]}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: [0, 1, 0],
                className: "text-brand",
              },
            ]}
          />,
        );
      });

      const labels = container.querySelectorAll("button");
      const middleLabel = labels[1] as HTMLButtonElement;
      const firstLabel = labels[0] as HTMLButtonElement;
      await act(async () => middleLabel.focus());
      expect([...container.querySelectorAll("svg line")].at(-1)?.getAttribute("x1")).toBe("372");

      await act(async () => {
        firstLabel.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      expect([...container.querySelectorAll("svg line")].at(-1)?.getAttribute("x1")).toBe("36");

      await act(async () => {
        firstLabel.dispatchEvent(
          new MouseEvent("mouseout", { bubbles: true, relatedTarget: container.firstElementChild }),
        );
      });
      expect([...container.querySelectorAll("svg line")].at(-1)?.getAttribute("x1")).toBe("372");
      expect(document.activeElement).toBe(middleLabel);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keyboard navigation takes ownership from a stationary pointer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AreaChart
            labels={["00:00", "01:00", "02:00"]}
            series={[
              {
                id: "tokens",
                label: "Tokens",
                values: [1, 2, 3],
                className: "text-brand",
              },
            ]}
          />,
        );
      });

      const firstLabel = container.querySelector("button") as HTMLButtonElement;
      const slider = container.querySelector('[role="slider"]') as SVGSVGElement;
      await act(async () => {
        firstLabel.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      expect([...container.querySelectorAll("svg line")].at(-1)?.getAttribute("x1")).toBe("36");

      await act(async () => {
        slider.focus();
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      });
      expect(slider.getAttribute("aria-valuenow")).toBe("2");
      expect(slider.getAttribute("aria-valuetext")).toBe("02:00. Tokens: 3.0");
      expect([...container.querySelectorAll("svg line")].at(-1)?.getAttribute("x1")).toBe("708");
      const tooltipTexts = [...container.querySelectorAll('[data-chart-tooltip="aligned"]')].map(
        (tooltip) => tooltip.textContent,
      );
      expect(tooltipTexts.some((text) => text?.includes("02:00"))).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
