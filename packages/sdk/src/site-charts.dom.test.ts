import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { SITE_CHARTS_JS } from "./site-charts";

type Draw = (el: unknown, options: unknown) => unknown;
type Format = (v: unknown, o?: unknown) => unknown;
type Og = {
  fmt: { date: Format; delta: Format };
  kpis: Draw;
  bars: Draw;
  line: Draw;
  scatter: Draw;
  table: Draw;
};

const WIDTH = 600;
let win: Window;
let og: Og;
const saved: Record<string, unknown> = {};
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  win = new Window({ url: "https://app.example/" });
  const proto = win.HTMLElement.prototype as unknown as object;
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => WIDTH });
  (win.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext =
    () => ({
      font: "",
      measureText: (t: string) => ({ width: t.length * 7 }),
    });
  for (const key of ["window", "document", "Node", "getComputedStyle", "requestAnimationFrame"]) {
    saved[key] = scope[key];
  }
  scope.window = win;
  scope.document = win.document;
  scope.Node = win.Node;
  scope.getComputedStyle = win.getComputedStyle.bind(win);
  scope.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  new Function(SITE_CHARTS_JS)();
  og = (win as unknown as { og: Og }).og;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) scope[key] = value;
  void win.happyDOM.close();
});

function mount(): HTMLElement {
  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  return el as unknown as HTMLElement;
}

describe("chart helpers in a DOM", () => {
  test("table: a string highlight marks the row whose first column matches", () => {
    const el = mount();
    og.table(el, {
      rows: [
        { name: "a", v: null },
        { name: "b", v: 2 },
      ],
      columns: [{ key: "name" }, { key: "v" }],
      highlight: "b",
    });
    const rows = el.querySelectorAll("tbody tr");
    expect(rows[1]!.className).toBe("og-highlight");
    expect(rows[0]!.className).toBe("");
    // A null first value still right-aligns a numeric column.
    expect(el.querySelectorAll("thead th")[1]!.className).toContain("og-num");
  });

  test("table: sorting keeps keyboard focus on the sort button", () => {
    const el = mount();
    og.table(el, { rows: [{ v: 1 }, { v: 3 }, { v: 2 }], columns: [{ key: "v" }] });
    (el.querySelector(".og-sort") as HTMLButtonElement).click();
    expect(win.document.activeElement).toBe(el.querySelector("th[aria-sort] .og-sort") as never);
    expect([...el.querySelectorAll("tbody th")].map((c) => c.textContent)).toEqual(["3", "2", "1"]);
  });

  test("bars: missing values sort last and labels are not read twice", () => {
    const el = mount();
    og.bars(el, {
      data: [
        { label: "a", v: -2 },
        { label: "b", v: null },
        { label: "c", v: 5 },
      ],
      value: "v",
    });
    const labels = [...el.querySelectorAll(".og-bars-label")];
    expect(labels.map((l) => l.textContent)).toEqual(["c", "a", "b"]);
    expect(labels.every((l) => l.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  test("line: unsorted x stays inside the frame and a lone point gets a dot", () => {
    const el = mount();
    og.line(el, {
      data: [
        { x: 3, y: 1 },
        { x: 1, y: null },
        { x: 2, y: 4 },
        { x: 4, y: null },
        { x: 5, y: 2 },
      ],
      x: "x",
      y: "y",
      refs: [{ label: "no value" }],
    });
    const d = el.querySelector(".og-line")!.getAttribute("d")!;
    const xs = [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(3);
    expect(Math.max(...xs)).toBeLessThanOrEqual(WIDTH);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(el.querySelectorAll("circle.og-dot")).toHaveLength(1);
    expect(el.innerHTML).not.toContain("NaN");
  });

  test("scatter: highlighting one point by label keeps the groups in colour", () => {
    const el = mount();
    og.scatter(el, {
      data: [
        { name: "ours", who: "A", x: 1, y: 2 },
        { name: "theirs", who: "B", x: 2, y: 1 },
      ],
      x: "x",
      y: "y",
      label: "name",
      group: "who",
      highlight: "ours",
    });
    const fills = [...el.querySelectorAll("circle.og-dot")].map((c) => c.getAttribute("style"));
    expect(fills.some((f) => f!.includes("--og-series-muted"))).toBe(false);
    expect(el.querySelector("svg")!.getAttribute("role")).toBe("group");
    expect(el.querySelectorAll("circle.og-dot-hl")).toHaveLength(1);
  });

  test("empty data shows the empty state", () => {
    const el = mount();
    og.line(el, { data: [], x: "x", y: "y", empty: "Nothing yet" });
    expect(el.querySelector(".og-empty")!.textContent).toBe("Nothing yet");
  });

  test("formats: date-only strings are local dates and rounded-to-zero deltas are flat", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York";
    const day = og.fmt.date("2026-01-15") as string;
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    expect(day).toContain("15");
    expect(og.fmt.delta(0.04)).toEqual({ text: "0%", tone: "flat" });
  });
});
