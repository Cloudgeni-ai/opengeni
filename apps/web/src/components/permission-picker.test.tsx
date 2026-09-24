import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { delegableApiKeyPermissions } from "@/lib/permissions";
import { PermissionGroupPicker } from "./permission-picker";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => GlobalRegistrator.unregister());

test("unavailable API key permissions cannot be selected or counted, but literal grants can", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const toggled: string[] = [];
  const groups = [
    { label: "Admin & account", permissions: ["account:admin", "billing:manage"] as const },
    { label: "Files & documents", permissions: ["files:read"] as const },
  ];
  const render = async (accountPermissions: string[]) => {
    await act(async () => {
      root.render(
        <PermissionGroupPicker
          groups={groups.map((group) => ({ ...group, permissions: [...group.permissions] }))}
          selected={new Set(["billing:manage", "files:read"])}
          delegable={delegableApiKeyPermissions(["workspace:admin"], accountPermissions)}
          onToggle={(permission) => toggled.push(permission)}
        />,
      );
    });
  };
  try {
    await render([]);
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes.map((checkbox) => [checkbox.disabled, checkbox.checked])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(container.querySelector("section")?.textContent).toContain("0/2");
    await act(async () => checkboxes[1]?.click());
    expect(toggled).toEqual([]);

    await render(["billing:manage"]);
    const updated = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(updated[0]?.disabled).toBe(true);
    expect(updated[1]?.disabled).toBe(false);
    await act(async () => updated[1]?.click());
    expect(toggled).toEqual(["billing:manage"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
