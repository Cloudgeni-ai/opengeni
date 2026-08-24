import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import { SessionVisibilityPicker } from "./session-visibility-picker";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

async function renderPicker(props: Partial<ComponentProps<typeof SessionVisibilityPicker>> = {}) {
  const selections: Array<"private" | "workspace"> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SessionVisibilityPicker
        id="new-session"
        personalWorkspace={false}
        value="workspace"
        capabilities={{
          activated: false,
          canCreatePrivate: false,
          reason: "not_activated",
        }}
        disabled={false}
        onChange={(visibility) => selections.push(visibility)}
        {...props}
      />,
    );
  });
  return { container, root, selections };
}

describe("session visibility picker", () => {
  test("omits a redundant chooser when workspace visibility is the only option", async () => {
    const view = await renderPicker();
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    await act(async () => view.root.unmount());
    view.container.remove();
  });

  test("labels a Personal workspace as already private without offering a choice", async () => {
    const view = await renderPicker({ personalWorkspace: true, value: "private" });
    expect(view.container.textContent).toContain("Only me");
    expect(view.container.textContent).toContain(
      "This is your Personal workspace, so the session is already private.",
    );
    expect(view.container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    await act(async () => view.root.unmount());
    view.container.remove();
  });

  test("shows both real choices after private session creation is activated", async () => {
    const view = await renderPicker({
      capabilities: {
        activated: true,
        canCreatePrivate: true,
        reason: "available",
      },
    });
    const radios = Array.from(
      view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(radios.map((radio) => radio.value)).toEqual(["workspace", "private"]);
    await act(async () => radios[1]?.click());
    expect(view.selections).toEqual(["private"]);
    await act(async () => view.root.unmount());
    view.container.remove();
  });
});
