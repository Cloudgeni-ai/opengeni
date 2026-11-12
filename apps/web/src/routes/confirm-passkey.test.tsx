import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly field: string | null = null,
    message = code ?? "failed",
  ) {
    super(message);
  }
}
mock.module("@/api", () => ({
  AuthApiError,
  confirmAdminWithPasskey: async () => {},
  readPasskeyStepUpHandoff: async () => ({ code: "000000" }),
  startPasskeyStepUpHandoff: async () => {
    throw new Error("not in this test");
  },
  passkeyStepUpConfirmed: async () => false,
}));

const { ConfirmPasskeyRoute } = await import("./confirm-passkey");
type ConfirmPasskeyApi = import("./confirm-passkey").ConfirmPasskeyApi;

const HANDOFF = "8f0c3c4e-2f6d-4a8a-9d43-1d8f0e3c6b21";

beforeAll(() => {
  GlobalRegistrator.register({ url: `https://opengeni.test/confirm-passkey?handoff=${HANDOFF}` });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount(api: ConfirmPasskeyApi) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ConfirmPasskeyRoute api={api} />));
  await flush();
  return {
    container,
    unmount: () => act(async () => root.unmount()),
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label,
      )!;
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

describe("confirming the desktop app's step-up in the browser", () => {
  test("shows the app's code, then confirms that handoff with the person's passkey", async () => {
    const confirmed: string[] = [];
    const view = await mount({
      read: async (handoffId) => {
        expect(handoffId).toBe(HANDOFF);
        return { code: "482913" };
      },
      confirm: async (handoffId) => {
        confirmed.push(handoffId);
      },
    });
    expect(view.container.textContent).toContain(
      "Continue only if the Opengeni app shows this code",
    );
    expect(view.container.textContent).toContain("482 913");
    await view.click("Use passkey");
    expect(confirmed).toEqual([HANDOFF]);
    expect(view.container.querySelector("h1")?.textContent).toBe("Confirmed");
    expect(view.container.textContent).toContain("The app continues by itself.");
    await view.unmount();
  });

  test("a browser signed in to another account is told so, and can't confirm", async () => {
    const view = await mount({
      read: async () => {
        throw new AuthApiError(403, "PASSKEY_HANDOFF_OTHER_ACCOUNT");
      },
      confirm: async () => {
        throw new Error("must not confirm");
      },
    });
    expect(view.container.querySelector("[role=alert]")?.textContent).toContain(
      "signed in to a different account than the app",
    );
    expect(view.container.querySelector("button")).toBeNull();
    await view.unmount();
  });

  test("a passkey prompt that fails keeps the page usable with a plain sentence", async () => {
    const dismissed = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    const view = await mount({
      read: async () => ({ code: "482913" }),
      confirm: async () => {
        throw dismissed;
      },
    });
    await view.click("Use passkey");
    expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
      "No passkey was used. Try again when you're ready.",
    );
    expect(
      [...view.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Use passkey",
      ),
    ).toBe(true);
    await view.unmount();
  });
});
