import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OrganizationUserSetupPreview } from "@opengeni/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { OrganizationInvitation } from "@/types";

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
const previewSetup = mock(
  async (_input: { token: string }): Promise<OrganizationUserSetupPreview> => ({
    state: "pending",
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationName: "Test Organization",
    targetEmail: "invitee@example.test",
    targetName: null,
    organizationRole: "member",
    sharedWorkspaceAccess: [],
    expiresAt: "2026-09-01T00:00:00.000Z",
  }),
);
let currentAuthSession: {
  session: { id: string; userId: string; expiresAt: string };
  user: { id: string; name: string; email: string; emailVerified: boolean };
} | null = null;
const fetchSession = mock(async () => currentAuthSession);
const listSetupInvitations = mock(
  async (): Promise<{
    invitations: OrganizationInvitation[];
    nextCursor: null;
  }> => ({
    invitations: [],
    nextCursor: null,
  }),
);
const acceptSetupInvitation = mock(async () => ({
  status: "complete" as const,
}));
const setupClient = {
  listOrganizationInvitations: listSetupInvitations,
  acceptOrganizationInvitation: acceptSetupInvitation,
};

class TestAuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly field: string | null,
    message: string,
  ) {
    super(message);
  }
}

mock.module("@/api", () => ({
  AuthApiError: TestAuthApiError,
  apiBaseUrl: "",
  completeOrganizationUserSetup: completeSetup,
  createOpenGeniClient: () => setupClient,
  fetchAuthSession: fetchSession,
  managedActorMutationBusySnapshot: () => false,
  previewOrganizationUserSetup: previewSetup,
  completeSelfServiceOrganizationSetup: completeSelfServiceSetup,
  getSelfServiceOrganizationOnboardingStatus: mock(async () => ({
    state: "required" as const,
  })),
  sendVerificationEmail: resendVerification,
  subscribeManagedActorInvalidation: () => () => undefined,
  subscribeManagedActorMutationBusy: () => () => undefined,
}));
mock.module("@tanstack/react-router", () => ({
  Link: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <a href="#signin" onClick={onClick}>
      {children}
    </a>
  ),
}));

const { ManagedAuthPanel } = await import("@/components/managed-auth-panel");
const { OrganizationOnboardingPanel } = await import("@/components/organization-onboarding-panel");
const { SetupAccountRoute, setupAccountTokenFromUrl } = await import("./setup-account");
const { takeBootstrappedSetupAccountToken } = await import("@/setup-account-token");
const VALID_FRAGMENT_SETUP_TOKEN = "A".repeat(43);
const VALID_QUERY_SETUP_TOKEN = "B".repeat(43);

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
      sessionStorage.clear();
    }
  });

  test("anchors invitation sign-in to the invited email until the user dismisses it", async () => {
    const onDismissInvitation = mock(() => undefined);
    const onSocialSubmit = mock(async () => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ManagedAuthPanel
            invitation={{
              organizationName: "Northwind Research",
              targetEmail: "invited@example.test",
            }}
            onDismissInvitation={onDismissInvitation}
            socialProviders={["google", "github"]}
            onSocialSubmit={onSocialSubmit}
            onSubmit={async () => undefined}
          />,
        ),
      );
      const email = container.querySelector<HTMLInputElement>("#managed-auth-email")!;
      expect(email.value).toBe("invited@example.test");
      expect(email.readOnly).toBeTrue();
      expect(container.textContent).toContain(
        "Sign in as invited@example.test to continue joining Northwind Research",
      );
      expect(container.textContent).not.toContain("Continue with Google");
      expect(container.textContent).not.toContain("Continue with GitHub");

      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find(
            (button) =>
              button.textContent?.trim() === "Use another account without this invitation",
          )!
          .click(),
      );
      expect(onDismissInvitation).toHaveBeenCalledTimes(1);
      expect(email.value).toBe("");
      expect(email.readOnly).toBeFalse();
      expect(container.textContent).toContain("Continue with Google");
      expect(container.textContent).toContain("Continue with GitHub");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("broker registration reveals resend only after signup succeeds", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ManagedAuthPanel
            initialMode="signup"
            allowedModes={["signup"]}
            presentation="embedded"
            onSubmit={async () => undefined}
          />,
        ),
      );
      expect(container.textContent).toContain("Create account");
      expect(container.textContent).not.toContain("Resend verification email");
      expect(
        Array.from(container.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Sign in",
        ),
      ).toBe(false);
      await enter(container.querySelector("#managed-auth-name")!, "Ada Lovelace");
      await enter(container.querySelector("#managed-auth-email")!, "ada@example.test");
      await enter(container.querySelector("#managed-auth-password")!, "password1234");
      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
      await flush();
      expect(container.textContent).toContain("Resend verification email");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("submit and resend keep identity controls fixed until the request settles", async () => {
    let resolveSubmit!: () => void;
    const submitted = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<ManagedAuthPanel initialMode="signup" onSubmit={submitted} />),
      );
      await enter(container.querySelector("#managed-auth-name")!, "Ada Lovelace");
      await enter(container.querySelector("#managed-auth-email")!, "ada@example.test");
      await enter(container.querySelector("#managed-auth-password")!, "password1234");

      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
      expect(container.querySelector<HTMLInputElement>("#managed-auth-email")!.disabled).toBeTrue();
      expect(
        Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Sign in",
        )!.disabled,
      ).toBeTrue();

      await act(async () => resolveSubmit());
      await flush();
      expect(container.textContent).toContain("Resend verification email");

      let resolveResend!: (value: { status: true }) => void;
      resendVerification.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveResend = resolve;
          }),
      );
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Resend verification email")!
          .click(),
      );
      expect(container.querySelector<HTMLInputElement>("#managed-auth-email")!.disabled).toBeTrue();
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      ).toBeTrue();

      await act(async () => resolveResend({ status: true }));
      await flush();
      expect(
        container.querySelector<HTMLInputElement>("#managed-auth-email")!.disabled,
      ).toBeFalse();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("ordinary sign-in hides resend until the account is known to be unverified", async () => {
    const submitted = mock(async () => {
      throw new TestAuthApiError(403, "EMAIL_NOT_VERIFIED", null, "Email not verified");
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ManagedAuthPanel onSubmit={submitted} />));
      expect(container.textContent).not.toContain("Resend verification email");
      await enter(container.querySelector("#managed-auth-email")!, "ada@example.test");
      await enter(container.querySelector("#managed-auth-password")!, "password1234");
      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
      await flush();
      expect(container.textContent).toContain("Verify your email before signing in.");
      expect(container.textContent).toContain("Resend verification email");

      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Resend verification email")!
          .click(),
      );
      await flush();
      expect(resendVerification).toHaveBeenCalledWith({ email: "ada@example.test" });

      await enter(container.querySelector("#managed-auth-email")!, "other@example.test");
      expect(container.textContent).not.toContain("Resend verification email");
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

  test("focuses the exact continued invitation across every page before the onboarding gate", async () => {
    sessionStorage.clear();
    const exactId = crypto.randomUUID();
    const exactOrganizationId = crypto.randomUUID();
    const unrelatedOrganizationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const exactInvitation = {
      id: exactId,
      organizationId: exactOrganizationId,
      organizationName: "Northwind Research",
      targetEmail: "grace@example.test",
      targetName: "Grace",
      initialWorkspaceIds: [],
      role: "member" as const,
      status: "pending" as const,
      revision: 2,
      expiresAt: "2026-09-08T00:00:00.000Z",
      acceptedMembershipId: null,
      createdAt: now,
      updatedAt: now,
    };
    const listOrganizationInvitations = mock(async (options: { cursor?: string; limit?: number }) =>
      options.cursor
        ? { invitations: [exactInvitation], nextCursor: null }
        : {
            invitations: [
              {
                ...exactInvitation,
                id: crypto.randomUUID(),
                organizationId: unrelatedOrganizationId,
                organizationName: "Contoso Engineering",
              },
            ],
            nextCursor: "page-2",
          },
    );
    const client = {
      listOrganizationInvitations,
      acceptOrganizationInvitation: mock(async () => ({ status: "complete" as const })),
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <OrganizationOnboardingPanel
            client={client as never}
            previewState="required"
            activeEmail="grace@example.test"
            invitation={{
              organizationId: exactOrganizationId,
              organizationName: exactInvitation.organizationName,
              targetEmail: exactInvitation.targetEmail,
              expiresAt: exactInvitation.expiresAt,
              createdAt: Date.parse("2026-09-01T12:00:00.000Z"),
            }}
            onComplete={() => undefined}
          />,
        ),
      );
      await flush();
      expect(listOrganizationInvitations.mock.calls).toEqual([
        [{ limit: 100 }],
        [{ cursor: "page-2", limit: 100 }],
      ]);
      expect(container.textContent).toContain("Join Northwind Research");
      expect(container.textContent).not.toContain("Contoso Engineering");
      expect(
        Array.from(container.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Join organization",
        ),
      ).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
    }
  });

  test("keeps unrelated invitations hidden while a no-workspace user switches accounts", async () => {
    sessionStorage.clear();
    const onUseInvitedAccount = mock(() => undefined);
    const targetOrganizationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const client = {
      listOrganizationInvitations: mock(async () => ({
        invitations: [
          {
            id: crypto.randomUUID(),
            organizationId: crypto.randomUUID(),
            organizationName: "Unrelated Organization",
            targetEmail: "other@example.test",
            targetName: null,
            initialWorkspaceIds: [],
            role: "member" as const,
            status: "pending" as const,
            revision: 1,
            expiresAt: "2026-09-08T00:00:00.000Z",
            acceptedMembershipId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: null,
      })),
      acceptOrganizationInvitation: mock(async () => ({ status: "complete" as const })),
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <OrganizationOnboardingPanel
            client={client as never}
            previewState="required"
            activeEmail="other@example.test"
            invitation={{
              organizationId: targetOrganizationId,
              organizationName: "Northwind Research",
              targetEmail: "grace@example.test",
              expiresAt: "2026-09-08T00:00:00.000Z",
              createdAt: Date.parse("2026-09-01T12:00:00.000Z"),
            }}
            onUseInvitedAccount={onUseInvitedAccount}
            onComplete={() => undefined}
          />,
        ),
      );
      await flush();
      expect(container.textContent).toContain("This invitation is for grace@example.test");
      expect(container.textContent).toContain("You're signed in as other@example.test");
      expect(container.textContent).not.toContain("Unrelated Organization");
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Switch account")!
          .click(),
      );
      expect(onUseInvitedAccount).toHaveBeenCalledWith("grace@example.test");
      expect(
        sessionStorage.getItem("opengeni:organization-invitation-continuation:v1"),
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
    }
  });

  test("invited-user setup requires confirmation and creates no implicit sign-in UI", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SetupAccountRoute token="setup-token" />));
      await flush();
      expect(container.textContent).toContain("Join Test Organization");
      expect(container.textContent).toContain("create an account to accept this invitation");
      expect(container.textContent).toContain("This invitation is for invitee@example.test");
      expect(container.textContent).toContain("you don't need to enter the email again");
      const existingAccountLink = Array.from(container.querySelectorAll("a")).find(
        (link) => link.textContent?.trim() === "Sign in as invitee@example.test",
      )!;
      await act(async () => existingAccountLink.click());
      expect(sessionStorage.getItem("opengeni:organization-invitation-continuation:v1")).toContain(
        "Test Organization",
      );
      await enter(container.querySelector("#setup-account-name")!, "Grace Hopper");
      await enter(container.querySelector("#setup-account-password")!, "password1234");
      await enter(container.querySelector("#setup-account-confirm")!, "password1234");
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Create account and join")!
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
      sessionStorage.clear();
    }
  });

  test("lets the invited signed-in account accept directly without account creation", async () => {
    const invitationId = crypto.randomUUID();
    const otherInvitationId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const otherWorkspaceId = crypto.randomUUID();
    const now = new Date().toISOString();
    previewSetup.mockImplementationOnce(async () => ({
      state: "pending",
      organizationId: "00000000-0000-4000-8000-000000000001",
      organizationName: "Test Organization",
      targetEmail: "invitee@example.test",
      targetName: "Grace Hopper",
      organizationRole: "member",
      sharedWorkspaceAccess: [{ workspaceId, workspaceName: "Expected workspace", role: "member" }],
      expiresAt: now,
    }));
    currentAuthSession = {
      session: { id: "session-1", userId: "user-1", expiresAt: now },
      user: {
        id: "user-1",
        name: "Grace Hopper",
        email: "INVITEE@example.test",
        emailVerified: true,
      },
    };
    listSetupInvitations.mockImplementationOnce(async () => ({
      invitations: [
        {
          id: otherInvitationId,
          organizationId: "00000000-0000-4000-8000-000000000001",
          organizationName: "Test Organization",
          targetEmail: "invitee@example.test",
          targetName: "Grace Hopper",
          initialWorkspaceIds: [otherWorkspaceId],
          role: "admin" as const,
          status: "pending" as const,
          revision: 3,
          expiresAt: now,
          acceptedMembershipId: null,
          createdAt: now,
          updatedAt: now,
          delivery: null,
        },
        {
          id: invitationId,
          organizationId: "00000000-0000-4000-8000-000000000001",
          organizationName: "Test Organization",
          targetEmail: "invitee@example.test",
          targetName: "Grace Hopper",
          initialWorkspaceIds: [workspaceId],
          role: "member" as const,
          status: "pending" as const,
          revision: 7,
          expiresAt: now,
          acceptedMembershipId: null,
          createdAt: now,
          updatedAt: now,
          delivery: null,
        },
      ],
      nextCursor: null,
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SetupAccountRoute token="signed-in-token" />));
      await flush();
      await flush();
      expect(container.textContent).toContain("Signed in as INVITEE@example.test");
      expect(container.textContent).toContain("No new account or password is needed");
      expect(container.querySelector("#setup-account-password")).toBeNull();
      const acceptButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Accept and join",
      )!;
      await act(async () => acceptButton.click());
      await flush();
      expect(acceptSetupInvitation).toHaveBeenCalledWith(invitationId, {
        expectedRevision: 7,
        operationId: expect.any(String),
      });
      expect(completeSetup).not.toHaveBeenCalledWith(
        expect.objectContaining({ token: "signed-in-token" }),
      );
      expect(container.textContent).toContain("Invitation accepted");
      expect(container.textContent).toContain("Open OpenGeni");
    } finally {
      currentAuthSession = null;
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps setup credentials absent across loading, failure, and every terminal preview", async () => {
    let resolveLoading!: (preview: OrganizationUserSetupPreview) => void;
    previewSetup.mockImplementationOnce(
      () =>
        new Promise<OrganizationUserSetupPreview>((resolve) => {
          resolveLoading = resolve;
        }),
    );
    const loadingContainer = document.createElement("div");
    document.body.appendChild(loadingContainer);
    const loadingRoot = createRoot(loadingContainer);
    try {
      await act(async () => loadingRoot.render(<SetupAccountRoute token="loading-token" />));
      expect(loadingContainer.textContent).toContain("Checking this invitation");
      expect(loadingContainer.querySelector("form")).toBeNull();
      expect(loadingContainer.querySelector("#setup-account-password")).toBeNull();
      await act(async () =>
        resolveLoading({
          state: "unavailable",
        }),
      );
      await flush();
    } finally {
      await act(async () => loadingRoot.unmount());
      loadingContainer.remove();
    }

    previewSetup.mockImplementationOnce(async () => {
      throw new Error("preview offline");
    });
    const failedContainer = document.createElement("div");
    document.body.appendChild(failedContainer);
    const failedRoot = createRoot(failedContainer);
    try {
      await act(async () => failedRoot.render(<SetupAccountRoute token="failed-token" />));
      await flush();
      expect(failedContainer.textContent).toContain("We couldn't check this invitation");
      expect(failedContainer.querySelector("form")).toBeNull();
      expect(failedContainer.querySelector("#setup-account-password")).toBeNull();
    } finally {
      await act(async () => failedRoot.unmount());
      failedContainer.remove();
    }

    for (const [state, title] of [
      ["unavailable", "This setup link is unavailable"],
      ["expired", "This setup link has expired"],
      ["revoked", "This invitation was revoked"],
      ["completed", "This account is already set up"],
    ] as const) {
      previewSetup.mockImplementationOnce(async () => ({ state }));
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<SetupAccountRoute token={`${state}-token`} />));
        await flush();
        expect(container.textContent).toContain(title);
        expect(container.querySelector("form")).toBeNull();
        expect(container.querySelector("#setup-account-name")).toBeNull();
        expect(container.querySelector("#setup-account-password")).toBeNull();
        expect(container.querySelector("#setup-account-confirm")).toBeNull();
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  });

  test("accepts one canonical fragment or compatibility query bearer and scrubs every URL token", () => {
    expect(
      setupAccountTokenFromUrl(
        `https://opengeni.test/setup-account?preview=1#token=${VALID_FRAGMENT_SETUP_TOKEN}&tab=invite`,
      ),
    ).toEqual({
      token: VALID_FRAGMENT_SETUP_TOKEN,
      scrubbedPath: "/setup-account?preview=1#tab=invite",
    });
    expect(
      setupAccountTokenFromUrl(
        `https://opengeni.test/setup-account?token=${VALID_QUERY_SETUP_TOKEN}&preview=1`,
      ),
    ).toEqual({ token: VALID_QUERY_SETUP_TOKEN, scrubbedPath: "/setup-account?preview=1" });
    expect(
      setupAccountTokenFromUrl(
        `https://opengeni.test/setup-account?token=${VALID_QUERY_SETUP_TOKEN}#token=${VALID_FRAGMENT_SETUP_TOKEN}`,
      ),
    ).toEqual({ token: null, scrubbedPath: "/setup-account" });
    expect(
      setupAccountTokenFromUrl(
        `https://opengeni.test/setup-account?token=${VALID_QUERY_SETUP_TOKEN}&token=${VALID_QUERY_SETUP_TOKEN}`,
      ),
    ).toEqual({ token: null, scrubbedPath: "/setup-account" });
    expect(setupAccountTokenFromUrl("https://opengeni.test/setup-account?token=logged")).toEqual({
      token: null,
      scrubbedPath: "/setup-account",
    });
    expect(
      setupAccountTokenFromUrl(`https://opengeni.test/setup-account#token=${"x".repeat(2_049)}`),
    ).toEqual({ token: null, scrubbedPath: "/setup-account" });
  });

  test("takes the early bootstrap bearer exactly once and revalidates its canonical shape", () => {
    Object.defineProperty(window, "__OPENGENI_SETUP_ACCOUNT_TOKEN__", {
      configurable: true,
      value: VALID_QUERY_SETUP_TOKEN,
    });
    expect(takeBootstrappedSetupAccountToken(window)).toBe(VALID_QUERY_SETUP_TOKEN);
    expect(takeBootstrappedSetupAccountToken(window)).toBeNull();
    Object.defineProperty(window, "__OPENGENI_SETUP_ACCOUNT_TOKEN__", {
      configurable: true,
      value: "malformed",
    });
    expect(takeBootstrappedSetupAccountToken(window)).toBeNull();
    expect("__OPENGENI_SETUP_ACCOUNT_TOKEN__" in window).toBe(false);
  });

  test("keeps the scrubbed fragment bearer across the lazy-route history remount only until preview settles", async () => {
    const previewCallCount = previewSetup.mock.calls.length;
    let resolveSecondPreview!: (preview: OrganizationUserSetupPreview) => void;
    previewSetup.mockImplementationOnce(
      () => new Promise<OrganizationUserSetupPreview>(() => undefined),
    );
    previewSetup.mockImplementationOnce(
      () =>
        new Promise<OrganizationUserSetupPreview>((resolve) => {
          resolveSecondPreview = resolve;
        }),
    );
    window.history.replaceState(null, "", "/setup-account");
    window.location.hash = `token=${VALID_FRAGMENT_SETUP_TOKEN}`;
    expect(window.location.hash).toBe(`#token=${VALID_FRAGMENT_SETUP_TOKEN}`);

    const firstContainer = document.createElement("div");
    document.body.appendChild(firstContainer);
    const firstRoot = createRoot(firstContainer);
    await act(async () => firstRoot.render(<SetupAccountRoute />));
    expect(window.location.href).not.toContain(VALID_FRAGMENT_SETUP_TOKEN);
    expect(firstContainer.textContent).toContain("Checking this invitation");
    await act(async () => firstRoot.unmount());
    firstContainer.remove();

    const secondContainer = document.createElement("div");
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);
    try {
      await act(async () => secondRoot.render(<SetupAccountRoute />));
      expect(secondContainer.textContent).toContain("Checking this invitation");
      expect(previewSetup.mock.calls.slice(-2).map(([request]) => request)).toEqual([
        { token: VALID_FRAGMENT_SETUP_TOKEN },
        { token: VALID_FRAGMENT_SETUP_TOKEN },
      ]);
      await act(async () =>
        resolveSecondPreview({
          state: "pending",
          organizationId: "00000000-0000-4000-8000-000000000001",
          organizationName: "Test Organization",
          targetEmail: "invitee@example.test",
          targetName: null,
          organizationRole: "member",
          sharedWorkspaceAccess: [],
          expiresAt: "2026-09-01T00:00:00.000Z",
        }),
      );
      await flush();
      expect(secondContainer.querySelector("#setup-account-password")).not.toBeNull();
      expect(secondContainer.textContent).not.toContain("This link is incomplete");
    } finally {
      await act(async () => secondRoot.unmount());
      secondContainer.remove();
    }

    const settledContainer = document.createElement("div");
    document.body.appendChild(settledContainer);
    const settledRoot = createRoot(settledContainer);
    try {
      await act(async () => settledRoot.render(<SetupAccountRoute />));
      expect(settledContainer.textContent).toContain("This link is incomplete");
      expect(previewSetup).toHaveBeenCalledTimes(previewCallCount + 2);
    } finally {
      await act(async () => settledRoot.unmount());
      settledContainer.remove();
    }
  });
});
