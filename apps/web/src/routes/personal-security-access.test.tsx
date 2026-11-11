import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  PersonalSecurityProvider,
  type PersonalSecurityContextValue,
} from "@/lib/personal-security-context";

if (!globalThis.document) GlobalRegistrator.register({ url: "https://app.example.com" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@/components/use-browser-account-popup", () => ({
  useBrowserAccountPopup: () => ({ open() {} }),
}));
mock.module("@opengeni/react/accounts", () => ({
  useBrowserAccounts: () => ({ projection: { selectedSlotId: "selected-slot" }, beginReauth() {} }),
}));
const actualApi = await import("@/api");
mock.module("@/api", () => ({ ...actualApi, apiBaseUrl: "https://app.example.com" }));
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

for (const crossOrigin of [false, true]) {
  for (const mode of ["legacy", "dual", "broker"] as const) {
    test(`personal Security validates origin before controls in ${mode} mode (crossOrigin=${crossOrigin})`, async () => {
      window.location.href = crossOrigin
        ? "https://app.example.com:8443/settings/security"
        : "https://app.example.com/settings/security";
      const calls: string[] = [];
      globalThis.fetch = (async (input) => {
        calls.push(String(input));
        return Response.json({
          email: "no-memberships@example.com",
          emailVerified: true,
          identityRevision: 1,
          identityId: "00000000-0000-4000-8000-000000000003",
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
          analytics: {
            consentRequired: true,
            providers: { posthog: { projectKey: "phc_test", host: "https://us.i.posthog.com" } },
          },
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
      const rootRoute = createRootRoute({
        component: () => (
          <PersonalSecurityProvider value={value}>
            <Outlet />
          </PersonalSecurityProvider>
        ),
      });
      const securityRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/security",
        component: PersonalSecurityRoute,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([securityRoute]),
        history: createMemoryHistory({ initialEntries: ["/settings/security"] }),
      });
      await router.load();
      await act(async () => root.render(<RouterProvider router={router} />));
      if (crossOrigin) {
        expect(host.textContent).toContain("Account security configuration required");
        expect(host.textContent).toContain("Ask the administrator");
        expect(host.textContent).toContain("Back to Opengeni");
        expect(host.textContent).toContain("Analytics preferences");
        expect(host.textContent).toContain("Manage");
        expect(host.textContent).not.toContain("Change password");
        expect(host.querySelector("input[type=password]")).toBeNull();
        expect(calls).toEqual([]);
        return;
      }
      expect(host.textContent).toContain("Security");
      expect(host.textContent).toContain("Change password");
      expect(host.textContent).toContain("Analytics preferences");
      expect(host.textContent).toContain("Manage");
      expect(calls).toEqual(["https://app.example.com/v1/auth/sign-in-methods"]);
    });
  }
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
