import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { NavGroup, NavItem, SettingsNav } from "./settings-nav";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("NavItem", () => {
  test("the active item is the current page and shows its bar", async () => {
    const view = await mount(
      <NavItem href="/schedules" label="Schedules" icon={<svg data-icon="" />} active />,
    );
    try {
      const link = view.container.querySelector("a")!;
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(link.getAttribute("data-active")).toBe("true");
      expect(link.textContent).toBe("Schedules");
    } finally {
      await view.cleanup();
    }
  });

  test("a router link child gets the item's content and classes", async () => {
    const view = await mount(
      <NavItem asChild label="Knowledge" attention attentionLabel="3 waiting for review">
        <a href="/knowledge" data-router-link="" />
      </NavItem>,
    );
    try {
      const links = view.container.querySelectorAll("a");
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(link.hasAttribute("data-router-link")).toBe(true);
      expect(link.getAttribute("data-slot")).toBe("nav-item");
      expect(link.textContent).toBe("Knowledge, 3 waiting for review");
      expect(link.getAttribute("aria-current")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a disabled item is not a link, stays focusable and carries its reason", async () => {
    const view = await mount(
      <NavItem
        href="/insights"
        label="Insights"
        active
        disabledReason="Only workspace admins can see Insights."
      />,
    );
    try {
      expect(view.container.querySelector("a")).toBeNull();
      const item = view.container.querySelector<HTMLElement>('[data-slot="nav-item"]')!;
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.getAttribute("role")).toBe("link");
      expect(item.textContent).toBe("Insights");
      expect(item.getAttribute("tabindex")).toBe("0");
      expect(item.getAttribute("aria-current")).toBeNull();
      const reasonId = item.getAttribute("aria-describedby")!.split(" ")[0]!;
      expect(document.getElementById(reasonId)?.textContent).toBe(
        "Only workspace admins can see Insights.",
      );
    } finally {
      await view.cleanup();
    }
  });

  test("a collapsed item keeps its name for screen readers", async () => {
    const view = await mount(
      <NavItem href="/schedules" label="Schedules" icon={<svg />} collapsed badge="2" />,
    );
    try {
      const link = view.container.querySelector("a")!;
      expect(link.querySelector(".sr-only")?.textContent).toBe("Schedules");
      // Counts hide with the label; the tooltip names the item.
      expect(link.textContent).toBe("Schedules");
    } finally {
      await view.cleanup();
    }
  });
});

describe("NavGroup and SettingsNav", () => {
  test("groups are labelled lists inside a named nav", async () => {
    const view = await mount(
      <SettingsNav aria-label="Workspace settings">
        <NavGroup label="Runtime">
          <NavItem href="/variable-sets" label="Variable sets" />
          <NavItem href="/machines" label="Machines" />
        </NavGroup>
      </SettingsNav>,
    );
    try {
      const nav = view.container.querySelector("nav")!;
      expect(nav.getAttribute("aria-label")).toBe("Workspace settings");
      const group = nav.querySelector('[role="group"]')!;
      const labelId = group.getAttribute("aria-labelledby")!;
      expect(document.getElementById(labelId)?.textContent).toBe("Runtime");
      expect(group.querySelectorAll("ul > li > a")).toHaveLength(2);
    } finally {
      await view.cleanup();
    }
  });
});
