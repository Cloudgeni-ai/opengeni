import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import * as ReactPackage from "@opengeni/react";
import * as RouterPackage from "@tanstack/react-router";
import * as ContextModule from "@/context";

const accountId = "account-strict";
const workspaceId = "workspace-strict";
const timestamp = "2026-08-20T10:00:00.000Z";
const toastError = mock((_message: string) => undefined);

const getBilling = mock(async () => ({
  mode: "stripe" as const,
  balance: {
    accountId,
    balanceMicros: 25_000_000,
    currency: "usd" as const,
    updatedAt: timestamp,
  },
}));
const getBillingEntitlements = mock(async () => ({
  accountId,
  mode: "managed" as const,
  entitlements: { seats: 10 },
}));
const createBillingCheckout = mock(async () => {
  throw new Error("bounded checkout failure");
});

const context = {
  client: {
    getBilling,
    getBillingEntitlements,
    createBillingCheckout,
  } as unknown as OpenGeniCoreClient,
  clientConfig: { auth: { mode: "managedSession" } },
  authSession: { user: { email: "owner@example.test" } },
  accessContext: {
    mode: "managed" as const,
    subjectId: "user:strict-owner",
    subjectLabel: "Strict Owner",
    accountGrants: [
      {
        accountId,
        subjectId: "user:strict-owner",
        role: "owner" as const,
        permissions: ["billing:read", "billing:manage"],
      },
    ],
    workspaceGrants: [],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  },
  workspaces: [
    {
      id: workspaceId,
      accountId,
      name: "Strict workspace",
      slug: null,
      externalSource: null,
      externalId: null,
      agentInstructions: null,
      settings: {},
      inferenceControl: {
        state: "active" as const,
        revision: 1,
        reason: null,
        changedBy: null,
        changedAt: null,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  managedSelfContext: null,
  accessKeyVersion: 7,
  handleManagedSignOut: async () => undefined,
  revalidatePrincipalAccess: () => undefined,
};

mock.module("@/context", () => ({ ...ContextModule, useAppContext: () => context }));
mock.module("@opengeni/react", () => ({
  ...ReactPackage,
  useBillingUsage: () => ({
    loading: false,
    error: null,
    usage: [],
    refresh: async () => undefined,
  }),
}));
mock.module("@tanstack/react-router", () => ({
  ...RouterPackage,
  Link: ({ children }: { children: ReactNode }) => <a href="#organization">{children}</a>,
}));
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    {
      error: toastError,
      success: mock((_message: string) => undefined),
    },
  ),
}));

const { OrgSettingsRoute } = await import("./org-settings");

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("organization billing StrictMode ownership", () => {
  test("keeps initial reads and a checkout mutation owned after setup cleanup setup", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <OrgSettingsRoute workspaceId={workspaceId} section="billing" />
        </StrictMode>,
      );
    });
    await flush();

    expect(getBilling.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getBillingEntitlements.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("$25.00 available");
    expect(container.textContent).toContain("seats");

    await act(async () => button(container, "Add credits").click());
    await flush();
    expect(createBillingCheckout).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Checkout failed", {
      description: "bounded checkout failure",
    });
    expect(button(container, "Add credits").disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});
