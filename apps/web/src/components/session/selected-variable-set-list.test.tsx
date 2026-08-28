import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import { SelectedVariableSetList } from "./selected-variable-set-list";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("SelectedVariableSetList", () => {
  test("keeps attach/use-only restored selections visible and removable without catalog rows", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    let latestSelectedIds = [firstId, secondId];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [selectedIds, setSelectedIds] = useState(latestSelectedIds);
      return (
        <SelectedVariableSetList
          selectedIds={selectedIds}
          variableSets={[]}
          disabled={false}
          onChange={(next) => {
            latestSelectedIds = next;
            setSelectedIds(next);
          }}
        />
      );
    }

    try {
      await act(async () => root.render(<Harness />));

      expect(container.textContent).toContain("Selected Variable Set 1");
      expect(container.textContent).toContain("Selected Variable Set 2");
      expect(container.textContent).not.toContain(firstId);
      expect(container.textContent).not.toContain(secondId);

      const moveFirstLater = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Move Selected Variable Set 1 later"]',
      );
      await act(async () => moveFirstLater?.click());
      expect(latestSelectedIds).toEqual([secondId, firstId]);

      const removeFirst = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove Selected Variable Set 1"]',
      );
      await act(async () => removeFirst?.click());
      expect(latestSelectedIds).toEqual([firstId]);
      expect(container.textContent).toContain("Selected Variable Set 1");
      expect(container.textContent).not.toContain("Selected Variable Set 2");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
