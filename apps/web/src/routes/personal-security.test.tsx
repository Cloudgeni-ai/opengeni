import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "@/api";
import type {
  createSignInMethodsApi,
  PreparedSignInCommand,
  SignInMethods,
} from "@/lib/sign-in-methods-api";

if (!globalThis.document) GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@/components/settings/personal-settings-shell", () => ({
  PersonalSettingsShell: ({ email, children }: { email: string; children: ReactNode }) => (
    <div>
      <span>{email}</span>
      {children}
    </div>
  ),
}));
const { SecurityController } = await import("./personal-security");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  sessionStorage.clear();
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
const inventory: SignInMethods = {
  identityId: "00000000-0000-4000-8000-000000000003",
  email: "person@example.com",
  emailVerified: true,
  identityRevision: 4,
  freshAuthenticationRequired: false,
  methods: [
    {
      provider: "google",
      connected: true,
      available: true,
      canDisconnect: true,
      implicitRelinkingSuppressed: false,
    },
    {
      provider: "github",
      connected: false,
      available: true,
      canDisconnect: false,
      implicitRelinkingSuppressed: true,
    },
    {
      provider: "credential",
      connected: true,
      available: true,
      canDisconnect: false,
      implicitRelinkingSuppressed: false,
    },
  ],
};
async function mount(
  execute: (command: PreparedSignInCommand) => Promise<unknown>,
  list: () => Promise<SignInMethods> = async () => inventory,
) {
  const commands: PreparedSignInCommand[] = [];
  const api = {
    list,
    async passkeyOptions() {
      return { challengeId: "c".repeat(32), options: {} };
    },
    async prepare(path, body) {
      return { path, body, headers: { "x-opengeni-session-csrf": "fixed-test-admission" } };
    },
    async execute(command) {
      commands.push(command);
      return await execute(command);
    },
  } as ReturnType<typeof createSignInMethodsApi>;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (userId = "actor-a", nextApi = api) =>
    act(async () =>
      root.render(
        <StrictMode>
          <SecurityController
            key={userId}
            mode="broker"
            userId={userId}
            email={`${userId}@example.com`}
            api={nextApi}
            onReauthenticate={() => {}}
          />
        </StrictMode>,
      ),
    );
  await render();
  return { commands, render, api };
}
async function click(label: string) {
  await act(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent === label || node.getAttribute("aria-label") === label,
    );
    expect(button).toBeDefined();
    button!.click();
  });
}
test("uncertain mutation retries exact command without generating a second operation", async () => {
  let attempt = 0;
  const { commands } = await mount(async () => {
    if (++attempt === 1) throw new Error("offline");
    throw new ApiError(409, "", { code: "identity_revision_conflict" });
  });
  await click("Reconnect GitHub");
  expect(host.textContent).toContain("result of this change is unknown");
  const first = commands[0]!;
  expect(first.body.expectedIdentityId).toBe(inventory.identityId);
  await click("Retry same request");
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(first);
  expect(host.textContent).toContain("Your sign-in methods changed");
  expect(host.textContent).not.toContain("Retry same request");
});

test("identity-change rejection never refreshes into a different mutation target", async () => {
  const { commands } = await mount(async () => {
    throw new ApiError(409, "", { code: "SIGN_IN_METHOD_IDENTITY_CHANGED" });
  });
  await click("Reconnect GitHub");
  expect(commands[0]!.body.expectedIdentityId).toBe(inventory.identityId);
  expect(host.textContent).toContain("signed-in account changed");
  const refresh = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Refresh sign-in methods",
  )!;
  const reauth = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Sign in again",
  )!;
  expect(refresh.disabled).toBe(true);
  expect(reauth.disabled).toBe(false);
  expect(
    (host.querySelector('[aria-label="Reconnect GitHub"]') as HTMLButtonElement).disabled,
  ).toBe(true);
});
test("refreshing inventory does not turn an uncertain result into permission for a new mutation", async () => {
  const { commands } = await mount(async () => {
    throw new Error("offline");
  });
  await click("Reconnect GitHub");
  await click("Refresh sign-in methods");
  expect(host.textContent).toContain("Retry same request");
  const reconnect = host.querySelector('[aria-label="Reconnect GitHub"]') as HTMLButtonElement;
  expect(reconnect.disabled).toBe(true);
  expect(commands).toHaveLength(1);
});
test("last-usable-method refusal never removes the connected provider optimistically", async () => {
  await mount(async () => {
    throw new ApiError(409, "", { code: "last_usable_method" });
  });
  await click("Disconnect Google");
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (node) => node.textContent === "Disconnect Google",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(document.body.textContent).toContain("can't remove your last usable");
  expect(host.textContent).toContain("person@example.com");
});
test("notification failure remains a committed change requiring reauth, never a retry", async () => {
  await mount(async () => ({ reauthenticationRequired: true, notification: "outcome_unknown" }));
  await click("Disconnect Google");
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (node) => node.textContent === "Disconnect Google",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(host.textContent).toContain("Sign-in methods updated");
  expect(host.textContent).toContain("change succeeded");
  expect(host.textContent).toContain("remaining sign-in method");
  expect(host.textContent).not.toContain("Retry same request");
  expect(host.querySelector('[aria-label="Disconnect Google"]')).toBeNull();
});
test("switching actors discards a late mutation result and its feedback", async () => {
  let release!: (value: unknown) => void;
  const { render } = await mount(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await click("Reconnect GitHub");
  await render("actor-b");
  await act(async () => release({ reauthenticationRequired: true, notification: "sent" }));
  expect(host.textContent).not.toContain("Sign-in methods updated");
  expect(sessionStorage.getItem("opengeni:sign-in-change-feedback")).toBeNull();
});

test("uncertainty locks new changes but not reauthentication after freshness expires", async () => {
  let freshRequired = false;
  await mount(
    async () => {
      throw new Error("offline");
    },
    async () => ({ ...inventory, freshAuthenticationRequired: freshRequired }),
  );
  await click("Reconnect GitHub");
  freshRequired = true;
  await click("Refresh sign-in methods");
  const reauth = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Sign in again",
  )!;
  expect(reauth.disabled).toBe(false);
  expect(
    (host.querySelector('[aria-label="Reconnect GitHub"]') as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(host.textContent).toContain("Retry same request");
});

test("removing one of several passkeys keeps this session signed in and reloads the list", async () => {
  const keys = [
    {
      id: "0b6f4d2e-6c1d-4f0a-9a43-2f1a7c3c9d10",
      name: "Laptop",
      createdAt: "2026-10-01T10:00:00.000Z",
      lastUsedAt: null,
      backedUp: true,
    },
    {
      id: "1c7f5e3f-7d2e-4a1b-8b54-3a2b8d4d0e21",
      name: "Security key",
      createdAt: "2026-10-02T10:00:00.000Z",
      lastUsedAt: null,
      backedUp: false,
    },
  ];
  let removed = false;
  const { commands } = await mount(
    async () => {
      removed = true;
      return { reauthenticationRequired: false, notification: "sent" };
    },
    async () => ({
      ...inventory,
      passkeys: removed ? keys.slice(1) : keys,
      passkeysAvailable: true,
      canRemovePasskey: true,
    }),
  );
  await click("Remove passkey Laptop");
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (node) => node.textContent === "Remove passkey",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(commands).toHaveLength(1);
  expect(commands[0]!.path).toBe("passkey/remove");
  expect(commands[0]!.body).toMatchObject({ passkeyId: keys[0]!.id });
  expect(host.textContent).toContain("Passkey removed.");
  expect(host.textContent).not.toContain("Sign in again as");
  expect(host.textContent).toContain("Security key");
  expect(host.textContent).not.toContain("Laptop");
});
