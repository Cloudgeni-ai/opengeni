import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  countActiveFilters,
  toggleFilter,
  ToolbarFilterChips,
  ToolbarGroup,
  ToolbarSearch,
  type ToolbarFilterGroup,
  type ToolbarFilterValue,
} from "./toolbar";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const groups: ToolbarFilterGroup[] = [
  {
    id: "type",
    label: "Type",
    options: [
      { id: "connection", label: "Connections" },
      { id: "skill", label: "Skills" },
    ],
  },
  { id: "status", label: "Status", options: [{ id: "needs_reconnect", label: "Needs reconnect" }] },
];

describe("filter values", () => {
  test("toggleFilter adds once, removes, and leaves other groups alone", () => {
    let value: ToolbarFilterValue = { status: ["needs_reconnect"] };
    value = toggleFilter(value, "type", "skill", true);
    value = toggleFilter(value, "type", "skill", true);
    expect(value).toEqual({ status: ["needs_reconnect"], type: ["skill"] });
    expect(countActiveFilters(value)).toBe(2);
    value = toggleFilter(value, "type", "skill", false);
    expect(value.type).toEqual([]);
    expect(countActiveFilters(value)).toBe(1);
  });
});

function SearchHarness({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("gmail");
  return (
    <ToolbarSearch
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      placeholder="Search connections, skills, and plugins"
    />
  );
}

describe("ToolbarSearch", () => {
  test("Escape and the clear button empty the field and keep focus in it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: string[] = [];
    try {
      await act(async () => root.render(<SearchHarness onChange={(v) => changes.push(v)} />));
      const input = container.querySelector("input")!;
      expect(input.getAttribute("aria-label")).toBe("Search connections, skills, and plugins");

      const clear = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear search"]',
      )!;
      await act(async () => clear.click());
      expect(changes).toEqual([""]);
      expect(document.activeElement).toBe(input);
      expect(container.querySelector('button[aria-label="Clear search"]')).toBeNull();

      // Escape with an empty field does nothing, so it can close an enclosing sheet.
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(changes).toEqual([""]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("ToolbarFilterChips", () => {
  test("shows one chip per applied option and removes it on click", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const seen: ToolbarFilterValue[] = [];
    try {
      await act(async () =>
        root.render(
          <ToolbarFilterChips
            groups={groups}
            value={{ type: ["skill", "connection"], status: [] }}
            onValueChange={(value) => seen.push(value)}
          />,
        ),
      );
      const chips = container.querySelectorAll('[aria-label="Active filters"] li');
      // Group order, then option order, independent of the order they were picked in.
      expect([...chips].map((chip) => chip.textContent)).toEqual([
        "Type:Connections",
        "Type:Skills",
      ]);
      const remove = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove filter Type: Skills"]',
      )!;
      await act(async () => remove.click());
      expect(seen).toEqual([{ type: ["connection"], status: [] }]);

      await act(async () =>
        root.render(<ToolbarFilterChips groups={groups} value={{}} onValueChange={() => {}} />),
      );
      expect(container.innerHTML).toBe("");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("layout on narrow toolbars", () => {
  test("the search keeps room for the clear button only while there is a value", () => {
    const empty = renderToStaticMarkup(
      <ToolbarSearch
        size="lg"
        value=""
        onValueChange={() => {}}
        placeholder="Search connections, skills, and plugins"
      />,
    );
    expect(empty).toMatch(/<input[^>]*class="[^"]*text-ellipsis[^"]*pr-4/);
    expect(empty).not.toMatch(/<input[^>]*class="[^"]*pr-11/);
    const filled = renderToStaticMarkup(
      <ToolbarSearch size="lg" value="gm" onValueChange={() => {}} placeholder="Search" />,
    );
    expect(filled).toMatch(/<input[^>]*class="[^"]*pr-11/);
  });

  test("a group wraps inside itself instead of running past the edge", () => {
    const end = renderToStaticMarkup(<ToolbarGroup align="end" />);
    expect(end).toContain("flex-wrap");
    expect(end).toContain("max-w-full");
    expect(end).toContain("ml-auto");
    expect(end).toContain("justify-end");
    expect(renderToStaticMarkup(<ToolbarGroup />)).not.toContain("justify-end");
  });
});
