import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const completeSetup = mock(
  async (_input: { token: string; name: string; password: string; operationId: string }) => ({
    status: "complete" as const,
  }),
);
const resendVerification = mock(async () => ({ status: true }));
const completeSelfServiceSetup = mock(async () => ({
  status: "complete" as const,
  organizationId: crypto.randomUUID(),
  personalWorkspaceId: crypto.randomUUID(),
}));

mock.module("@/api", () => ({
  AuthApiError: class AuthApiError extends Error {},
  completeOrganizationUserSetup: completeSetup,
  previewOrganizationUserSetup: mock(async () => ({
    state: "pending" as const,
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationName: "Test Organization",
    targetEmail: "invitee@example.test",
    targetName: null,
    organizationRole: "member" as const,
    sharedWorkspaceAccess: [],
    expiresAt: "2026-09-01T00:00:00.000Z",
  })),
  completeSelfServiceOrganizationSetup: completeSelfServiceSetup,
  getSelfServiceOrganizationOnboardingStatus: mock(async () => ({
    state: "required" as const,
  })),
  sendVerificationEmail: resendVerification,
}));
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#signin">{children}</a>,
}));

const { ManagedAuthPanel } = await import("@/components/managed-auth-panel");
const { OrganizationOnboardingPanel } = await import("@/components/organization-onboarding-panel");
const { SetupAccountRoute, setupAccountTokenFromUrl } = await import("./setup-account");

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

async function enter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onChange = (
      input as unknown as Record<
        string,
        { onChange?: (event: { target: HTMLInputElement }) => void }
      >
    )[reactPropsKey!]!.onChange;
    onChange!({ target: input });
  });
}

async function flush(): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("organization onboarding UI", () => {
  test("self-service signup submits only ordinary account fields", async () => {
    const submitted = mock(async () => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<ManagedAuthPanel initialMode="signup" onSubmit={submitted} />),
      );
      expect(container.textContent).not.toContain("Organization name");
      expect(container.textContent).not.toContain("First workspace");
      await enter(container.querySelector("#managed-auth-name")!, "Ada Lovelace");
      await enter(container.querySelector("#managed-auth-email")!, "ada@example.test");
      await enter(container.querySelector("#managed-auth-password")!, "password1234");
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Create account")!
          .click(),
      );
      await flush();
      expect(submitted).toHaveBeenCalledWith("signup", {
        name: "Ada Lovelace",
        email: "ada@example.test",
        password: "password1234",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("post-sign-in setup asks only for an organization name", async () => {
    const onComplete = mock(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <OrganizationOnboardingPanel previewState="required" onComplete={onComplete} />,
        ),
      );
      expect(container.textContent).toContain("Create your organization");
      expect(container.textContent).toContain("Organization name");
      expect(container.textContent).not.toContain("Workspace name");
      expect(container.querySelectorAll("input")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("terminal organization access shows a bounded unavailable state without a setup gate", async () => {
    const onComplete = mock(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <OrganizationOnboardingPanel previewState="unavailable" onComplete={onComplete} />,
        ),
      );
      expect(container.textContent).toContain("Organization access unavailable");
      expect(container.textContent).toContain("Ask an organization administrator");
      expect(container.textContent).not.toContain("Create your organization");
      expect(container.querySelector("form")).toBeNull();
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps multiple registered-user invitations explicit and accepts only the chosen one", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const firstOrganizationId = crypto.randomUUID();
    const secondOrganizationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const acceptOrganizationInvitation = mock(async () => ({ status: "complete" }));
    const client = {
      listOrganizationInvitations: mock(async () => ({
        invitations: [
          {
            id: firstId,
            organizationId: firstOrganizationId,
            organizationName: "Northwind Research",
            targetEmail: "grace@example.test",
            targetName: "Grace",
            initialWorkspaceIds: [],
            role: "member" as const,
            status: "pending" as const,
            revision: 2,
            expiresAt: now,
            acceptedMembershipId: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: secondId,
            organizationId: secondOrganizationId,
            organizationName: "Contoso Engineering",
            targetEmail: "grace@example.test",
            targetName: "Grace",
            initialWorkspaceIds: [],
            role: "admin" as const,
            status: "pending" as const,
            revision: 4,
            expiresAt: now,
            acceptedMembershipId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: null,
      })),
      acceptOrganizationInvitation,
    };
    const onComplete = mock(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <OrganizationOnboardingPanel
            client={client as never}
            previewState="invitation_pending"
            onComplete={onComplete}
          />,
        ),
      );
      await flush();
      expect(container.textContent).toContain("Northwind Research");
      expect(container.textContent).toContain("Contoso Engineering");
      expect(container.textContent).not.toContain(firstOrganizationId.slice(0, 8));
      expect(container.textContent).not.toContain(secondOrganizationId.slice(0, 8));
      const joinButtons = Array.from(container.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Join organization",
      );
      expect(joinButtons).toHaveLength(2);
      await act(async () => joinButtons[1]!.click());
      await flush();
      expect(acceptOrganizationInvitation).toHaveBeenCalledTimes(1);
      expect(acceptOrganizationInvitation).toHaveBeenCalledWith(secondId, {
        expectedRevision: 4,
        operationId: expect.any(String),
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("invited-user setup requires confirmation and creates no implicit sign-in UI", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SetupAccountRoute token="setup-token" />));
      expect(container.textContent).toContain("Create your login for the organization");
      await enter(container.querySelector("#setup-account-name")!, "Grace Hopper");
      await enter(container.querySelector("#setup-account-password")!, "password1234");
      await enter(container.querySelector("#setup-account-confirm")!, "password1234");
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Create account")!
          .click(),
      );
      await flush();
      expect(completeSetup).toHaveBeenCalledTimes(1);
      expect(completeSetup.mock.calls[0]?.[0]).toMatchObject({
        token: "setup-token",
        name: "Grace Hopper",
        password: "password1234",
      });
      expect(container.textContent).toContain("Account ready");
      expect(container.textContent).toContain("Sign in");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("accepts setup authority only from a bounded fragment and scrubs every URL token", () => {
    expect(
      setupAccountTokenFromUrl(
        "https://opengeni.test/setup-account?token=logged&preview=1#token=fragment-secret&tab=invite",
      ),
    ).toEqual({
      token: "fragment-secret",
      scrubbedPath: "/setup-account?preview=1#tab=invite",
    });
    expect(setupAccountTokenFromUrl("https://opengeni.test/setup-account?token=logged")).toEqual({
      token: null,
      scrubbedPath: "/setup-account",
    });
    expect(
      setupAccountTokenFromUrl(`https://opengeni.test/setup-account#token=${"x".repeat(2_049)}`),
    ).toEqual({ token: null, scrubbedPath: "/setup-account" });
  });
});
