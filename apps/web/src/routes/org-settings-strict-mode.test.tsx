import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import * as ReactPackage from "@opengeni/react";
import * as RouterPackage from "@tanstack/react-router";
import * as ContextModule from "@/context";
import type { CompanyProfileAgentPolicy } from "@/types";

const accountId = "account-strict";
const workspaceId = "workspace-strict";
const otherAccountId = "account-other";
const otherWorkspaceId = "workspace-other";
const timestamp = "2026-08-20T10:00:00.000Z";
const toastError = mock((_message: string) => undefined);
let accountRole: "owner" | "admin" = "owner";

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
const createBillingPortalSession = mock(async () => {
  throw new Error("bounded portal failure");
});
const listOrganizationApiKeys = mock(async (_accountId: string) => []);
const createOrganizationApiKey = mock(async () => {
  throw new Error("not used");
});
const deleteOrganizationApiKey = mock(async () => {
  throw new Error("not used");
});
const listCompanyProfile = mock(async (_workspaceId: string, _options: { limit: number }) => ({
  current: null,
  activeRevision: null,
  revisions: [],
  activationEvents: [],
  nextAfterRevision: null,
}));
const defaultGetCompanyProfileAgentPolicy = async (
  _workspaceId: string,
): Promise<CompanyProfileAgentPolicy> => ({
  organizationId: accountId,
  mode: "suggest" as const,
  version: 0,
  updatedAt: timestamp,
});
const getCompanyProfileAgentPolicy = mock(defaultGetCompanyProfileAgentPolicy);
const updateCompanyProfileAgentPolicy = mock(
  async (
    _workspaceId: string,
    _request: {
      mode: "off" | "suggest" | "automatic";
      expectedVersion: number;
      operationId: string;
    },
  ) => ({
    organizationId: accountId,
    mode: "automatic" as const,
    version: 1,
    updatedAt: timestamp,
    changed: true,
  }),
);
const getWorkspaceModelCatalog = mock(async (_workspaceId: string) => ({ models: [] }));
const useBillingUsage = mock((_options: unknown) => ({
  loading: false,
  error: null,
  usage: [],
  refresh: async () => undefined,
}));

const context = {
  client: {
    getBilling,
    getBillingEntitlements,
    createBillingCheckout,
    createBillingPortalSession,
    listOrganizationApiKeys,
    createOrganizationApiKey,
    deleteOrganizationApiKey,
    listCompanyProfile,
    getCompanyProfileAgentPolicy,
    updateCompanyProfileAgentPolicy,
    getWorkspaceModelCatalog,
  } as unknown as OpenGeniBrowserClient,
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
        get role(): "owner" | "admin" {
          return accountRole;
        },
        permissions: ["account:admin", "billing:read", "billing:manage", "api_keys:manage"],
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
      kind: "shared",
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
  model: "openai/gpt-5.6",
  reasoningEffort: "low" as const,
  latencyMode: "standard" as const,
  busy: false,
  startSession: async () => null,
  handleManagedSignOut: async () => undefined,
  revalidatePrincipalAccess: () => undefined,
};

mock.module("@/context", () => ({ ...ContextModule, useAppContext: () => context }));
mock.module("@opengeni/react", () => ({
  ...ReactPackage,
  useBillingUsage,
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

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    // The developer section is loaded through React.lazy. On a busy runner,
    // StrictMode's two effect passes may settle after more than one tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
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
  test("keeps initial reads and billing mutations owned after setup cleanup setup", async () => {
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
    expect(useBillingUsage.mock.calls.at(-1)?.[0]).toEqual({
      accountId,
      enabled: true,
    });
    expect(container.textContent).toContain(
      "View invoices and manage payment information in Stripe.",
    );
    expect(container.textContent).not.toContain("OG-0042");

    await act(async () => button(container, "Add credits").click());
    await flush();
    expect(createBillingCheckout).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Checkout failed", {
      description: "bounded checkout failure",
    });
    expect(button(container, "Add credits").disabled).toBe(false);

    await act(async () => button(container, "Open Stripe billing").click());
    await flush();
    expect(createBillingPortalSession).toHaveBeenCalledTimes(1);
    expect(createBillingPortalSession).toHaveBeenCalledWith({
      accountId,
      returnUrl: window.location.href,
    });
    expect(toastError).toHaveBeenCalledWith("Couldn't open Stripe billing", {
      description: "bounded portal failure",
    });
    expect(button(container, "Open Stripe billing").disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  test("loads organization keys with the organization SDK method", async () => {
    listOrganizationApiKeys.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <OrgSettingsRoute workspaceId={workspaceId} section="developer" />
        </StrictMode>,
      );
    });
    await waitFor(
      () =>
        listOrganizationApiKeys.mock.calls.length >= 2 &&
        container.textContent?.includes("No organization API keys yet") === true,
      "organization API key reads did not settle under StrictMode",
    );

    expect(listOrganizationApiKeys.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      listOrganizationApiKeys.mock.calls.every(([seenAccountId]) => seenAccountId === accountId),
    ).toBe(true);
    expect(container.textContent).toContain("Organization API keys");
    expect(container.textContent).toContain("No organization API keys yet");

    await act(async () => root.unmount());
    container.remove();
  });

  test("updates the organization-wide agent identity mode with CAS", async () => {
    getCompanyProfileAgentPolicy.mockClear();
    updateCompanyProfileAgentPolicy.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <OrgSettingsRoute workspaceId={workspaceId} section="knowledge" />
        </StrictMode>,
      );
    });
    await flush();

    expect(getCompanyProfileAgentPolicy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("Agent-managed organization identity");
    expect(container.textContent).toContain("Require approval");
    expect(container.textContent).not.toContain("Review first");
    const automatic = container.querySelector<HTMLInputElement>(
      'input[name="company-profile-agent-policy"][value="automatic"]',
    );
    if (!automatic) throw new Error("Missing Autonomous policy option");
    await act(async () => {
      automatic.click();
      await Promise.resolve();
    });
    await flush();

    expect(updateCompanyProfileAgentPolicy).toHaveBeenCalledTimes(1);
    expect(updateCompanyProfileAgentPolicy.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(updateCompanyProfileAgentPolicy.mock.calls[0]?.[1]).toMatchObject({
      mode: "automatic",
      expectedVersion: 0,
    });
    expect(updateCompanyProfileAgentPolicy.mock.calls[0]?.[1].operationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(container.textContent).toContain(
      "Autonomous organization identity updates are enabled.",
    );

    await act(async () => root.unmount());
    container.remove();
  });

  test("discards an old organization policy load after the route identity changes", async () => {
    getCompanyProfileAgentPolicy.mockClear();
    updateCompanyProfileAgentPolicy.mockClear();
    let resolveOldPolicy!: (value: CompanyProfileAgentPolicy) => void;
    const oldPolicy = new Promise<CompanyProfileAgentPolicy>((resolve) => {
      resolveOldPolicy = resolve;
    });
    getCompanyProfileAgentPolicy.mockImplementation(async (seenWorkspaceId) => {
      if (seenWorkspaceId === workspaceId) return await oldPolicy;
      return {
        organizationId: otherAccountId,
        mode: "automatic",
        version: 7,
        updatedAt: timestamp,
      };
    });

    const workspace = context.workspaces[0]!;
    const grant = context.accessContext.accountGrants[0]!;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<OrgSettingsRoute workspaceId={workspaceId} section="knowledge" />);
      });
      await flush();
      expect(getCompanyProfileAgentPolicy).toHaveBeenCalledWith(workspaceId);

      workspace.id = otherWorkspaceId;
      workspace.accountId = otherAccountId;
      grant.accountId = otherAccountId;
      context.accessContext.defaultAccountId = otherAccountId;
      context.accessContext.defaultWorkspaceId = otherWorkspaceId;
      await act(async () => {
        root.render(<OrgSettingsRoute workspaceId={otherWorkspaceId} section="knowledge" />);
      });
      await flush();

      const selectedMode = () =>
        container.querySelector<HTMLInputElement>(
          'input[name="company-profile-agent-policy"]:checked',
        )?.value;
      expect(selectedMode()).toBe("automatic");

      await act(async () =>
        resolveOldPolicy({
          organizationId: accountId,
          mode: "suggest",
          version: 0,
          updatedAt: timestamp,
        }),
      );
      await flush();
      expect(selectedMode()).toBe("automatic");

      const off = container.querySelector<HTMLInputElement>(
        'input[name="company-profile-agent-policy"][value="off"]',
      );
      if (!off) throw new Error("Missing Off policy option");
      await act(async () => {
        off.click();
        await Promise.resolve();
      });
      await flush();
      expect(updateCompanyProfileAgentPolicy).toHaveBeenCalledWith(
        otherWorkspaceId,
        expect.objectContaining({ mode: "off", expectedVersion: 7 }),
      );
    } finally {
      getCompanyProfileAgentPolicy.mockImplementation(defaultGetCompanyProfileAgentPolicy);
      workspace.id = workspaceId;
      workspace.accountId = accountId;
      grant.accountId = accountId;
      context.accessContext.defaultAccountId = accountId;
      context.accessContext.defaultWorkspaceId = workspaceId;
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not load the owner-only agent identity policy for an account administrator", async () => {
    getCompanyProfileAgentPolicy.mockClear();
    accountRole = "admin";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <OrgSettingsRoute workspaceId={workspaceId} section="knowledge" />
          </StrictMode>,
        );
      });
      await flush();

      expect(getCompanyProfileAgentPolicy).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Agent-managed organization identity mode");
      expect(container.textContent).toContain("Agent-managed organization identity is owner-only");
    } finally {
      accountRole = "owner";
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
