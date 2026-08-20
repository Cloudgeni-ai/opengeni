import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ResourceScopePicker, resourceScopeLabel } from "./resource-scope-picker";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("resource scope picker", () => {
  test("presents the three product scopes with truthful availability", async () => {
    const selected: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ResourceScopePicker
          id="rig"
          value="workspace"
          onChange={(scope) => selected.push(scope)}
          organizationEnabled={false}
          personalEnabled
        />,
      );
    });

    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.value)).toEqual(["organization", "workspace", "user"]);
    expect(radios[0]?.disabled).toBe(true);
    expect(radios[1]?.checked).toBe(true);
    expect(radios[2]?.disabled).toBe(false);
    await act(async () => radios[2]?.click());
    expect(selected).toEqual(["user"]);
    expect(container.textContent).toContain("Only me");
    expect(container.textContent).toContain(
      "Organization owners can create organization resources",
    );

    await act(async () => root.unmount());
    container.remove();
  });

  test("uses the same labels in creation and inventory surfaces", () => {
    expect(resourceScopeLabel("organization")).toBe("Organization");
    expect(resourceScopeLabel("workspace")).toBe("Workspace");
    expect(resourceScopeLabel("user")).toBe("Only me");
  });
});
