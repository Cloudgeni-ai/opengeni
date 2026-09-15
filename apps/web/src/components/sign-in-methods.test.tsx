import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SignInMethodsViewProps } from "./sign-in-methods";

if (!globalThis.document) GlobalRegistrator.register();
const { SignInMethodsView } = await import("./sign-in-methods");
afterAll(() => GlobalRegistrator.unregister());
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
const base: SignInMethodsViewProps = {
  methods: [
    {
      provider: "google",
      connected: true,
      available: true,
      email: "person@example.com",
      handle: null,
      canDisconnect: false,
      reconnectRequired: false,
    },
    {
      provider: "github",
      connected: false,
      available: true,
      email: null,
      handle: null,
      canDisconnect: false,
      reconnectRequired: true,
    },
  ],
  hasPassword: false,
  passwordAvailable: true,
  busy: false,
  recentAuthRequired: false,
  error: null,
  success: null,
  onReauthenticate() {},
  onConnect() {},
  async onDisconnect() {
    return true;
  },
  async onPassword() {
    return true;
  },
};
async function mount(overrides: Partial<SignInMethodsViewProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (next: Partial<SignInMethodsViewProps> = {}) =>
    act(async () => root.render(<SignInMethodsView {...base} {...overrides} {...next} />));
  await render();
  return render;
}
function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  )!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(id: string, value: string) {
  await act(async () => {
    const input = document.getElementById(id) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const key = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    (
      input as unknown as Record<
        string,
        { onChange: (event: { target: HTMLInputElement }) => void }
      >
    )[key]!.onChange({ target: input });
  });
}

test("shows provider identity and protects the last usable method without conflating integrations", async () => {
  await mount();
  expect(host.textContent).toContain("person@example.com");
  expect(button("Disconnect Google").disabled).toBe(true);
  expect(host.textContent).toContain("last usable sign-in method");
  expect(button("Reconnect GitHub").disabled).toBe(false);
  expect(host.textContent).toContain("Repository access, Gmail, and Google Drive are separate");
});

test("fresh authentication locks sensitive actions and never automatically resubmits them", async () => {
  let reauth = 0;
  let changes = 0;
  await mount({
    recentAuthRequired: true,
    onReauthenticate() {
      reauth++;
    },
    onConnect() {
      changes++;
    },
  });
  expect(button("Reconnect GitHub").disabled).toBe(true);
  expect(button("Set password").disabled).toBe(true);
  await click("Sign in again");
  expect(reauth).toBe(1);
  expect(changes).toBe(0);
});

test("unavailable providers and password sign-in remain truthful and disabled", async () => {
  await mount({ methods: [{ ...base.methods[1]!, available: false }], passwordAvailable: false });
  expect(button("Reconnect GitHub").disabled).toBe(true);
  expect(button("Set password").disabled).toBe(true);
  expect(host.textContent).toContain("unavailable on this deployment");
});

test("disconnect requires explicit confirmation and failed mutation stays visible", async () => {
  let calls = 0;
  await mount({
    methods: [{ ...base.methods[0]!, canDisconnect: true }],
    async onDisconnect() {
      calls++;
      return false;
    },
  });
  await click("Disconnect Google");
  expect(calls).toBe(0);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("explicitly reconnect");
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (node) => node.textContent === "Disconnect Google",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(calls).toBe(1);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

test("password form validates confirmation and discards secrets after submission", async () => {
  const received: string[] = [];
  await mount({
    async onPassword(password) {
      received.push(password);
      return false;
    },
  });
  await click("Set password");
  await fill("signin-new-password", "new-secret-password");
  await fill("signin-confirm-password", "different-password");
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(received).toEqual([]);
  expect(host.textContent).toContain("passwords don't match");
  await fill("signin-confirm-password", "new-secret-password");
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(received).toEqual(["new-secret-password"]);
  expect((document.getElementById("signin-new-password") as HTMLInputElement).value).toBe("");
  expect((document.getElementById("signin-confirm-password") as HTMLInputElement).value).toBe("");
});

test("provider handles are plain text and pending operations disable every mutation", async () => {
  await mount({
    busy: true,
    methods: [{ ...base.methods[0]!, email: null, handle: "@octocat", canDisconnect: true }],
  });
  expect(host.textContent).toContain("@octocat");
  expect(button("Disconnect Google").disabled).toBe(true);
  expect(button("Set password").disabled).toBe(true);
});
