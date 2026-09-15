import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  PersonalSecurityProvider,
  type PersonalSecurityContextValue,
} from "@/lib/personal-security-context";

if (!globalThis.document) GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@/components/settings/personal-settings-shell", () => ({
  PersonalSettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module("@/components/use-browser-account-popup", () => ({
  useBrowserAccountPopup: () => ({ open() {} }),
}));
mock.module("@opengeni/react/accounts", () => ({
  useBrowserAccounts: () => ({ projection: { selectedSlotId: "selected-slot" }, beginReauth() {} }),
}));
const { PersonalSecurityRoute } = await import("./personal-security");
const originalFetch = globalThis.fetch;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

for (const mode of ["legacy", "broker"] as const) {
  test(`direct personal Security needs no workspace context in ${mode} mode`, async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return Response.json({
        email: "no-memberships@example.com",
        emailVerified: true,
        identityRevision: 1,
        freshAuthenticationRequired: false,
        methods: [
          {
            provider: "credential",
            connected: true,
            available: true,
            canDisconnect: false,
            implicitRelinkingSuppressed: false,
          },
        ],
      });
    }) as typeof fetch;
    const value: PersonalSecurityContextValue = {
      clientConfig: {
        auth: { mode: "managedSession", session: "cookie" },
        managedAuthSessionSetMode: mode,
      } as PersonalSecurityContextValue["clientConfig"],
      authSession: {
        session: { id: "session", userId: "human", expiresAt: "2030-01-01T00:00:00Z" },
        user: { id: "human", name: "Human", email: "no-memberships@example.com" },
      },
      accessKeyVersion: 1,
      async handleManagedSignOut() {},
      revalidatePrincipalAccess() {},
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    // Deliberately no AppContext, workspace grants, memberships or default workspace.
    await act(async () =>
      root.render(
        <PersonalSecurityProvider value={value}>
          <PersonalSecurityRoute />
        </PersonalSecurityProvider>,
      ),
    );
    expect(host.textContent).toContain("Security");
    expect(host.textContent).toContain("Change password");
    expect(calls).toEqual(["/v1/auth/sign-in-methods"]);
  });
}

test("root keeps personal Security after managed authentication and before workspace/onboarding gates", async () => {
  const source = await Bun.file(new URL("../context.tsx", import.meta.url)).text();
  const auth = source.indexOf(") : managedAuthRequired && !authSession ? (");
  const personal = source.indexOf("<PersonalSecurityProvider");
  const workspaceError = source.indexOf(") : accessError && !accessLoading ? (");
  const onboarding = source.indexOf("<BrowserAccountsOrganizationOnboardingPanel", workspaceError);
  expect(auth).toBeGreaterThan(0);
  expect(personal).toBeGreaterThan(auth);
  expect(workspaceError).toBeGreaterThan(personal);
  expect(onboarding).toBeGreaterThan(personal);
  expect(source.slice(auth, workspaceError)).toContain(
    "browserAccountsConfigured && !browserAccountsEnabled",
  );
  expect(source.slice(workspaceError)).toContain("<BrowserAccountsRuntime");
});
