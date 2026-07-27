import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { EnabledMcpToolPicker } from "@/components/pickers";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const SERVERS = [
  { id: "opengeni", name: "OpenGeni" },
  { id: "linear", name: "Linear" },
];

describe("session turn tool picker hydration fence", () => {
  test("fences the Linear picker trigger until delayed draft hydration completes", async () => {
    let releaseDraft!: () => void;
    const draftHydrated = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    let selected = new Set(["opengeni"]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [draftLoading, setDraftLoading] = useState(true);
      const [selectedIds, setSelectedIds] = useState(() => new Set(selected));
      useEffect(() => {
        void draftHydrated.then(() => setDraftLoading(false));
      }, []);
      return (
        <EnabledMcpToolPicker
          servers={SERVERS}
          selectedIds={selectedIds}
          disabled={draftLoading}
          label="Tools for this turn"
          onChange={(next) => {
            selected = next;
            setSelectedIds(next);
          }}
        />
      );
    }

    try {
      await act(async () => root.render(<Harness />));
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Tools for this turn"]',
      );
      expect(trigger).not.toBeNull();
      expect(trigger!.disabled).toBe(true);

      await act(async () => {
        trigger!.click();
      });
      expect(selected).toEqual(new Set(["opengeni"]));
      expect(container.querySelector('[role="menu"]')).toBeNull();

      await act(async () => releaseDraft());
      expect(trigger!.disabled).toBe(false);
      // The pending server response did not get an opportunity to replace a
      // local picker edit: the trigger was fenced for the entire delay, and
      // the controlled selection remains authoritative when it becomes usable.
      expect(selected).toEqual(new Set(["opengeni"]));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
