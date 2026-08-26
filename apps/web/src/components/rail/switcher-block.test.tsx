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
  kind: "shared",
  name: "cloudgeni",
  inferenceControl: { state: "active" },
} as Workspace;

describe("WorkspaceSwitcherTrigger", () => {
  test("forwards the Radix asChild ref onto the native button", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const ref: RefObject<HTMLButtonElement | null> = createRef();
    await act(async () => {
      root.render(
        <WorkspaceSwitcherTrigger
          ref={ref}
          activeWorkspace={workspace}
          activeOrganizationLabel="Org 049d0b24"
          personal={workspace.kind === "personal"}
          collapsed={false}
        />,
      );
    });
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.getAttribute("aria-label")).toContain("Switch workspace");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
