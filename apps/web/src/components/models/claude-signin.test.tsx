import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { ProviderConnectionView } from "../ai-gateway-connection";

let createRoot: typeof import("react-dom/client").createRoot;
let ClaudeSignInPage: typeof import("./claude-signin").ClaudeSignInPage;
let root: Root;
let container: HTMLDivElement;
const scopeId = "22222222-2222-4222-8222-222222222222";
const nextId = "33333333-3333-4333-8333-333333333333";
const attempt = (attemptId: string) => ({
  attemptId,
  authorizationUrl: "https://claude.com/cai/oauth/authorize?state=test",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  ({ ClaudeSignInPage } = await import("./claude-signin"));
});
beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());
const render = async (state: ProviderConnectionView, onConnected = () => {}) =>
  act(async () =>
    root.render(createElement(ClaudeSignInPage, { state, onClose: () => {}, onConnected })),
  );
const remount = async (state: ProviderConnectionView) => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(state);
};
const fill = async (label: string, value: string) =>
  act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () =>
  act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
for (const scope of ["workspace", "organization"] as const) {
  const organization = scope === "organization";
  const key = `opengeni.claude-signin:${scope}:${scopeId}`;
  const stateFor = (client: object, saveKey: (token: string) => Promise<boolean>) =>
    ({
      organization,
      connected: false,
      canManageConnection: true,
      accessTarget: {
        client,
        ...(organization ? { organizationId: scopeId } : { workspaceId: scopeId }),
      },
      saveKey,
      refreshConnection: async () => {},
    }) as unknown as ProviderConnectionView;
  test(`${scope}: successful setup-token fallback clears an existing browser attempt`, async () => {
    sessionStorage.setItem(key, JSON.stringify(attempt(scopeId)));
    const tokens: string[] = [];
    let connected = 0;
    const state = stateFor({}, async (token) => {
      tokens.push(token);
      return true;
    });
    await render(state, () => {
      connected++;
    });
    const disclosure = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Use a setup token"),
    )!;
    await act(async () => disclosure.click());
    await fill("Claude subscription setup token", "sk-ant-oat01-test");
    await submit();
    expect(tokens).toEqual(["sk-ant-oat01-test"]);
    expect(connected).toBe(1);
    expect(sessionStorage.getItem(key)).toBeNull();
    await remount({ ...state, connected: true });
    expect(container.querySelector('input[aria-label="Claude authorization code"]')).toBeNull();
    expect(container.querySelector('button[type="submit"]')?.textContent).toBe("Sign in to Claude");
  });
  test(`${scope}: late completion from an unmounted form preserves a newer attempt`, async () => {
    sessionStorage.setItem(key, JSON.stringify(attempt(scopeId)));
    let rejectComplete!: (error: unknown) => void;
    const completing = new Promise<never>((_resolve, reject) => {
      rejectComplete = reject;
    });
    const state = stateFor(
      {
        completeWorkspaceClaudeSubscriptionOAuth: () => completing,
        completeOrganizationClaudeSubscriptionOAuth: () => completing,
      },
      async () => true,
    );
    await render(state);
    await fill("Claude authorization code", "code#test");
    await submit();
    await act(async () => root.unmount());
    sessionStorage.setItem(key, JSON.stringify(attempt(nextId)));
    root = createRoot(container);
    await render(state);
    await act(async () => {
      rejectComplete(
        new OpenGeniApiError(
          409,
          JSON.stringify({ error: "Claude connection changed. Start sign-in again." }),
        ),
      );
      await Promise.resolve();
    });
    expect(JSON.parse(sessionStorage.getItem(key)!).attemptId).toBe(nextId);
    await remount(state);
    expect(container.querySelector('input[aria-label="Claude authorization code"]')).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')?.textContent).toBe("Complete sign-in");
  });
}
