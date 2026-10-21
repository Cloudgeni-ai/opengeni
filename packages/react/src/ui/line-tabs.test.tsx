import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LineTabs, LineTabsLink, LineTabsList, LineTabsNav, LineTabsTrigger } from "./line-tabs";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(node: ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, root };
}

describe("LineTabs", () => {
  test("a count with a label is read as words, not as a bare number", async () => {
    const { container, root } = await render(
      <LineTabs defaultValue="library">
        <LineTabsList aria-label="Knowledge" trailing={<button type="button">Add</button>}>
          <LineTabsTrigger value="library">Library</LineTabsTrigger>
          <LineTabsTrigger value="review" count={3} countTone="attention" countLabel="3 waiting">
            Review
          </LineTabsTrigger>
        </LineTabsList>
      </LineTabs>,
    );
    try {
      const review = [...container.querySelectorAll('[role="tab"]')].find((tab) =>
        tab.textContent?.startsWith("Review"),
      )!;
      const badge = review.querySelector('[data-slot="line-tab-count"]')!;
      expect(badge.getAttribute("aria-hidden")).toBe("true");
      expect(badge.className).toContain("text-status-waiting");
      expect(review.textContent).toContain(", 3 waiting");
      // The trailing action sits outside the tablist, on the same rule.
      const bar = container.querySelector('[data-slot="line-tabs-bar"]')!;
      expect(bar.querySelector('[role="tablist"] button[type="button"]:not([role])')).toBeNull();
      expect(bar.querySelector('[data-slot="line-tabs-trailing"] button')?.textContent).toBe("Add");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("the pill variant styles every trigger as a pill", async () => {
    const { container, root } = await render(
      <LineTabs defaultValue="all">
        <LineTabsList variant="pill" aria-label="Capability types">
          <LineTabsTrigger value="all" count={10}>
            All
          </LineTabsTrigger>
          <LineTabsTrigger value="skill">Skills</LineTabsTrigger>
        </LineTabsList>
      </LineTabs>,
    );
    try {
      const tabs = [...container.querySelectorAll('[role="tab"]')];
      expect(tabs).toHaveLength(2);
      for (const tab of tabs) expect(tab.className).toContain("rounded-full");
      expect(tabs[0]!.getAttribute("data-state")).toBe("active");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("link tabs mark the current page and accept a router link as the child", async () => {
    const { container, root } = await render(
      <LineTabsNav aria-label="Workspace settings">
        <LineTabsLink href="/settings/general" active>
          General
        </LineTabsLink>
        <LineTabsLink asChild count={2}>
          <a href="/settings/access" data-router-link="">
            Access
          </a>
        </LineTabsLink>
      </LineTabsNav>,
    );
    try {
      const links = [...container.querySelectorAll("a")];
      expect(links).toHaveLength(2);
      expect(links[0]!.getAttribute("aria-current")).toBe("page");
      expect(links[0]!.getAttribute("data-state")).toBe("active");
      expect(links[1]!.hasAttribute("data-router-link")).toBe(true);
      expect(links[1]!.getAttribute("aria-current")).toBeNull();
      expect(links[1]!.className).toContain("h-11");
      expect(links[1]!.textContent).toBe("Access2");
      expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("scrolls a newly active tab into view without scrolling the page", async () => {
    const tabs = ["overview", "setup", "checks", "versions", "changes"];
    let setValue: (value: string) => void = () => {};
    function Harness() {
      const [value, set] = useState("overview");
      setValue = set;
      return (
        <LineTabs value={value} onValueChange={set}>
          <LineTabsList aria-label="Platform CI">
            {tabs.map((tab) => (
              <LineTabsTrigger key={tab} value={tab}>
                {tab}
              </LineTabsTrigger>
            ))}
          </LineTabsList>
        </LineTabs>
      );
    }
    const { container, root } = await render(<Harness />);
    try {
      const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
      // A 100px viewport over five 70px tabs, 80px apart.
      Object.defineProperty(list, "clientWidth", { configurable: true, value: 100 });
      Object.defineProperty(list, "scrollWidth", { configurable: true, value: 390 });
      list.getBoundingClientRect = () => new DOMRect(0, 0, 100, 44);
      container.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, index) => {
        tab.getBoundingClientRect = () => new DOMRect(index * 80 - list.scrollLeft, 0, 70, 44);
      });
      expect(list.scrollLeft).toBe(0);
      await act(async () => setValue("versions"));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      // Right edge of "versions" (310) - viewport (100) + 24px of breathing room.
      expect(list.scrollLeft).toBe(234);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
