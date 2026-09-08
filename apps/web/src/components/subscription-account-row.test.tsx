import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubscriptionAccountRow } from "./subscription-account-row";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
for (const provider of ["Codex", "SuperGrok"]) {
  test(`${provider} account selection, plan, and rename share the same controls`, async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const select = mock(() => {});
    const rename = mock((_name: string) => {});
    function Example() {
      const [expanded, setExpanded] = useState(false);
      return (
        <SubscriptionAccountRow
          provider={provider}
          name="Team plan"
          label="Team plan"
          email="team@example.test"
          plan="Team"
          selected={false}
          disabled={false}
          selectionLabel="Use Team plan"
          group="test-active"
          expanded={expanded}
          onExpandedChange={setExpanded}
          onSelect={select}
          onRename={rename}
        >
          <p>Subscription details</p>
        </SubscriptionAccountRow>
      );
    }
    try {
      await act(async () => root.render(<Example />));
      expect(container.textContent).toContain("Team plan · team@example.test");
      expect(container.textContent).toContain("Team");
      expect(container.textContent).not.toContain("Subscription details");
      await act(async () =>
        container.querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
      );
      expect(select).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("Subscription details");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Show details for Team plan"]')!
          .click(),
      );
      expect(container.textContent).toContain("Subscription details");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Rename Team plan"]')!
          .click(),
      );
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Name for Team plan"]',
      )!;
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(rename).not.toHaveBeenCalled();
      expect(container.querySelector('input[aria-label="Name for Team plan"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
