import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef, type RefObject } from "react";
import { createRoot } from "react-dom/client";

import { WorkspaceSwitcherTrigger } from "@/components/rail/switcher-block";
import type { Workspace } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const workspace = {
  id: "ws-1",
  name: "cloudgeni",
  inferenceControl: { state: "active" },
} as Workspace;

describe("WorkspaceSwitcherTrigger", () => {
  test("forwards the Radix asChild ref and rest handlers onto the native button", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const ref: RefObject<HTMLButtonElement | null> = createRef();
    let pointerDown = 0;
    await act(async () => {
      root.render(
        <WorkspaceSwitcherTrigger
          ref={ref}
          activeWorkspace={workspace}
          activeOrganizationLabel="Org 049d0b24"
          personal={false}
          collapsed={false}
          onPointerDown={() => {
            pointerDown += 1;
          }}
        />,
      );
    });
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.getAttribute("aria-label")).toContain("Switch workspace");
    ref.current?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pointerDown).toBe(1);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
