import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { UserResourceAuthoritySummary } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   "Use for my messages in …": a person turns their own subscription on for
   the messages they send in one shared workspace (D-53). Being on is a
   standing `subscription_connection.use` grant there.
   -------------------------------------------------------------------------- */

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { OwnSubscriptionTurnsRow } = await import("./own-subscription-turns");

afterAll(() => {
  GlobalRegistrator.unregister();
});

const PLACE = { workspaceId: "design", workspaceName: "Design" };

function authority(grants: UserResourceAuthoritySummary["grants"]): UserResourceAuthoritySummary {
  return {
    authorityId: "authority-1",
    resourceKind: "subscription_connection",
    resourceId: "codex-1",
    originWorkspaceId: "personal",
    generation: 1,
    status: "active",
    grants,
  } as UserResourceAuthoritySummary;
}

function standing(workspaceId: string, status: "active" | "revoked" = "active") {
  return {
    grantId: `grant-${workspaceId}`,
    targetWorkspaceId: workspaceId,
    targetSessionId: null,
    action: "subscription_connection.use",
    mode: "always",
    context: "workspace_shared",
    authorityEpoch: 1,
    generation: 1,
    status,
    expiresAt: null,
  } as unknown as UserResourceAuthoritySummary["grants"][number];
}

let grants: UserResourceAuthoritySummary["grants"] = [];
const client = {
  listUserResourceAuthorities: mock(async () => ({
    authorities: [authority(grants)],
    nextCursor: null,
  })),
  issueUserResourceGrant: mock(async () => ({ grant: { grantId: "grant-new" } })),
  revokeUserResourceGrant: mock(async () => ({})),
};

beforeEach(() => {
  grants = [];
  for (const fn of Object.values(client)) fn.mockClear();
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const row = () => (
  <OwnSubscriptionTurnsRow
    client={client as never}
    place={PLACE}
    connectionId="codex-1"
    name="Codex"
  />
);
const control = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("[role='switch']")!;

test("an account is off until its owner turns it on here, then it is a standing grant", async () => {
  // A grant for another workspace doesn't turn it on here.
  grants = [standing("platform")];
  const view = await render(row());
  try {
    expect(view.container.textContent).toContain("Use for my messages in Design");
    expect(control(view.container).getAttribute("aria-checked")).toBe("false");
    await act(async () => control(view.container).click());
    expect(client.issueUserResourceGrant).toHaveBeenCalledWith("design", "authority-1", {
      scope: "user",
      resourceKind: "subscription_connection",
      mode: "always",
      context: "workspace_shared",
      workspaceSharedAcknowledged: true,
    });
    expect(control(view.container).getAttribute("aria-checked")).toBe("true");
  } finally {
    await view.cleanup();
  }
});

test("turning it off revokes this workspace's grant only", async () => {
  grants = [standing("design"), standing("platform")];
  const view = await render(row());
  try {
    expect(control(view.container).getAttribute("aria-checked")).toBe("true");
    await act(async () => control(view.container).click());
    expect(client.revokeUserResourceGrant).toHaveBeenCalledWith("design", "grant-design");
    expect(client.revokeUserResourceGrant).toHaveBeenCalledTimes(1);
    expect(control(view.container).getAttribute("aria-checked")).toBe("false");
  } finally {
    await view.cleanup();
  }
});

test("a revoked grant reads as off, and a failed change puts the switch back and says why", async () => {
  grants = [standing("design", "revoked")];
  client.issueUserResourceGrant.mockImplementationOnce(async () => {
    throw new Error("Couldn't turn it on.");
  });
  const view = await render(row());
  try {
    expect(control(view.container).getAttribute("aria-checked")).toBe("false");
    await act(async () => control(view.container).click());
    expect(control(view.container).getAttribute("aria-checked")).toBe("false");
    expect(view.container.textContent).toContain("Couldn't turn it on.");
  } finally {
    await view.cleanup();
  }
});
