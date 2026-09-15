import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

if (!globalThis.document) GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const creations: string[] = [];
mock.module("@/components/settings/personal-settings-shell", () => ({
  PersonalSettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module("@/lib/sign-in-methods-api", () => ({
  createSignInMethodsApi: (mode: string) => {
    creations.push(mode);
    const instance = creations.length;
    return {
      async list() {
        return {
          identityId: "00000000-0000-4000-8000-000000000003",
          email: `client-${instance}@example.com`,
          emailVerified: true,
          identityRevision: 1,
          freshAuthenticationRequired: false,
          methods: [],
        };
      },
    };
  },
}));
const { SecurityController } = await import("./personal-security");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("an actor change recreates the epoch-capturing API without requiring a keyed remount", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (userId: string) =>
    act(async () =>
      root.render(
        <SecurityController
          mode="legacy"
          userId={userId}
          email={`${userId}@example.com`}
          onReauthenticate={() => {}}
        />,
      ),
    );
  try {
    await render("actor-a");
    expect(creations).toEqual(["legacy"]);
    await render("actor-a");
    expect(creations).toEqual(["legacy"]);
    await render("actor-b");
    expect(creations).toEqual(["legacy", "legacy"]);
    await render("actor-a");
    expect(creations).toEqual(["legacy", "legacy", "legacy"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
