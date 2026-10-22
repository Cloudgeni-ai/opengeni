import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { CheckboxField } from "./field";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("a disabled checkbox dims with its description, but its reason stays legible and described", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <CheckboxField label="Alex Morgan" description="alex@example.com" disabled />
          <CheckboxField
            label="Design"
            description="Not shown while locked"
            disabledReason="Connected in this workspace, so it's always included."
            disabled
            checked
          />
          <CheckboxField
            label="Legal"
            description="Shared workspace"
            disabledReason="Only shown while disabled"
          />
        </>,
      ),
    );
    const note = (text: string) =>
      [...container.querySelectorAll("span[id]")].find((span) => span.textContent === text);
    // Read-only: the description dims with its label, so the name still leads.
    expect(note("alex@example.com")?.className).toContain("opacity-60");
    // Locked: the reason replaces the description at full contrast, and describes the box.
    const reason = note("Connected in this workspace, so it's always included.")!;
    expect(reason.className).not.toContain("opacity-60");
    expect(container.textContent).not.toContain("Not shown while locked");
    const locked = [...container.querySelectorAll("input[type=checkbox]")].find(
      (element) => element.getAttribute("aria-describedby") === reason.id,
    );
    expect(locked).toBeDefined();
    // Enabled: the description shows, not the reason.
    expect(note("Shared workspace")).toBeDefined();
    expect(container.textContent).not.toContain("Only shown while disabled");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
