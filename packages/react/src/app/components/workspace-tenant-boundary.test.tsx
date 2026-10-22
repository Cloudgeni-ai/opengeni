import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { WorkspaceTenantBoundary } from "./workspace-tenant-boundary";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("WorkspaceTenantBoundary", () => {
  test("never commits the previous workspace surface under a new route", async () => {
    const transitions: string[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <WorkspaceTenantBoundary
          workspaceId="workspace-b"
          stateOwnerWorkspaceId="workspace-a"
          prepareTransition={(workspaceId) => transitions.push(workspaceId)}
        >
          <button type="button">Workspace A action</button>
        </WorkspaceTenantBoundary>,
      );
    });

    expect(container.textContent).toContain("Switching workspace");
    expect(container.textContent).not.toContain("Workspace A action");
    expect(transitions).toEqual(["workspace-b"]);

    await act(async () => {
      root.render(
        <WorkspaceTenantBoundary
          workspaceId="workspace-b"
          stateOwnerWorkspaceId="workspace-b"
          prepareTransition={(workspaceId) => transitions.push(workspaceId)}
        >
          <button type="button">Workspace B action</button>
        </WorkspaceTenantBoundary>,
      );
    });

    expect(container.textContent).toContain("Workspace B action");
    expect(container.textContent).not.toContain("Switching workspace");
    expect(transitions).toEqual(["workspace-b"]);
    await act(async () => root.unmount());
  });
});
