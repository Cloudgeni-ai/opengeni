import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const navigations: unknown[] = [];
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => (to: unknown) => {
    navigations.push(to);
    return Promise.resolve();
  },
}));
class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(code ?? "failed");
  }
}
mock.module("@/api", () => ({
  AuthApiError,
  confirmAdminWithPasskey: async () => {},
  startPasskeyStepUpHandoff: async () => {
    throw new Error("not in this test");
  },
  claimPasskeyStepUpHandoff: async () => {},
}));
// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@opengeni/react/ui/form-dialog", () => ({
  FormDialog: ({
    title,
    description,
    submitLabel,
    submitDisabled,
    error,
    children,
    footerStart,
    onOpenChange,
    onSubmit,
    aboveOtherDialogs,
  }: {
    aboveOtherDialogs?: boolean;
    title: ReactNode;
    description?: ReactNode;
    submitLabel: ReactNode;
    submitDisabled?: boolean;
    error?: ReactNode;
    children?: ReactNode;
    footerStart?: ReactNode;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => unknown;
  }) => (
    <div role="dialog" data-above-other-dialogs={aboveOtherDialogs ? "" : undefined}>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
      {error ? <p role="alert">{error}</p> : null}
      {footerStart}
      <button
        type="button"
        disabled={submitDisabled}
        onClick={() => {
          void (async () => {
            if ((await onSubmit()) !== false) onOpenChange(false);
          })();
        }}
      >
        {submitLabel}
      </button>
      <button type="button" onClick={() => onOpenChange(false)}>
        Cancel
      </button>
    </div>
  ),
}));

const { AdminStepUpDialog } = await import("./admin-step-up-dialog");
type StepUpHandoffApi = import("./admin-step-up-dialog").StepUpHandoffApi;
const { withAdminStepUp } = await import("@/lib/admin-step-up");
const { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } =
  await import("@opengeni/contracts/managed-sign-in-methods");

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://opengeni.test/workspaces" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const refusal = (passkeyRegistered: boolean) =>
  Response.json(
    {
      error: {
        code: "forbidden",
        message: "Confirm it's you",
        details: { code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE, passkeyRegistered },
      },
    },
    { status: 403 },
  );

async function mount(confirm: () => Promise<void>, browser?: { handoff: StepUpHandoffApi }) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      browser ? (
        <AdminStepUpDialog confirm={confirm} inBrowser handoff={browser.handoff} />
      ) : (
        <AdminStepUpDialog confirm={confirm} inBrowser={false} />
      ),
    ),
  );
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

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("AdminStepUpDialog", () => {
  test("asks for the passkey, then the refused change goes through", async () => {
    let confirmations = 0;
    const view = await mount(async () => {
      confirmations += 1;
    });
    let sends = 0;
    const change = withAdminStepUp(
      async () => {
        sends += 1;
        return sends === 1 ? refusal(true) : Response.json({ saved: true });
      },
      { input: "/v1/organizations/o", init: { method: "PATCH", body: "{}" } },
    );
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Confirm it's you");
    // Any open surface can raise it, the chat's connect dialog included.
    expect(view.container.querySelector("[data-above-other-dialogs]")).not.toBeNull();
    // Once per session, not every few minutes.
    expect(view.container.textContent).toContain("You won't be asked again until you sign out.");
    await view.click("Use passkey");
    expect((await change).status).toBe(200);
    expect(confirmations).toBe(1);
    expect(view.container.querySelector("[role=dialog]")).toBeNull();
    await view.unmount();
  });

  test("keeps the prompt open with a plain sentence when the passkey is dismissed", async () => {
    const dismissed = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    const view = await mount(async () => {
      throw dismissed;
    });
    const change = withAdminStepUp(async () => refusal(true), {
      input: "/v1/x",
      init: { method: "POST", body: "{}" },
    });
    await flush();
    await view.click("Use passkey");
    expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
      "No passkey was used. Try again when you're ready.",
    );
    await view.click("Cancel");
    expect((await change).status).toBe(403);
    await view.unmount();
  });

  test("sends someone without a passkey to add one", async () => {
    const view = await mount(async () => {});
    const change = withAdminStepUp(async () => refusal(false), {
      input: "/v1/x",
      init: { method: "POST", body: "{}" },
    });
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Add a passkey");
    expect(view.container.querySelector("[data-above-other-dialogs]")).not.toBeNull();
    await view.click("Add passkey");
    expect((await change).status).toBe(403);
    expect(navigations).toEqual([{ to: "/settings/security" }]);
    await view.unmount();
  });
});

describe("AdminStepUpDialog in the desktop app", () => {
  const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const HANDOFF = "8f0c3c4e-2f6d-4a8a-9d43-1d8f0e3c6b21";
  const browser = (expiresInMs = 600_000) => {
    const opened: string[] = [];
    const claims: string[] = [];
    const handoff: StepUpHandoffApi = {
      start: async () => ({
        handoffId: HANDOFF,
        // A wrong clock here doesn't matter: the dialog counts from now.
        expiresAt: new Date(0).toISOString(),
        expiresInSeconds: expiresInMs / 1000,
      }),
      claim: async (handoffId, code) => {
        expect(handoffId).toBe(HANDOFF);
        claims.push(code);
        if (code !== "482913") {
          throw Object.assign(new AuthApiError(422, "PASSKEY_HANDOFF_WRONG_CODE"), {
            message: "That code isn't right. Check the code your browser shows.",
          });
        }
      },
      open: (url) => opened.push(url),
    };
    return { handoff, opened, claims };
  };
  // Typing, as React sees it: the input's own change handler with the new value.
  const type = async (container: HTMLElement, value: string) => {
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(
        input,
        value,
      );
      const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
      (
        input as unknown as Record<
          string,
          { onChange: (event: { target: HTMLInputElement }) => void }
        >
      )[propsKey]!.onChange({ target: input });
    });
  };
  const submit = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Confirm")!;

  test("hands the passkey to the browser on the same server; the browser's code confirms this app", async () => {
    let nativeCeremonies = 0;
    const { handoff, opened, claims } = browser();
    const view = await mount(
      async () => {
        nativeCeremonies += 1;
      },
      { handoff },
    );
    let sends = 0;
    const change = withAdminStepUp(
      async () => {
        sends += 1;
        return sends === 1 ? refusal(true) : Response.json({ saved: true });
      },
      { input: "/v1/workspaces/w/model-account-settings", init: { method: "PUT", body: "{}" } },
    );
    await flush();
    await view.click("Continue in browser");
    expect(opened).toEqual([`${window.location.origin}/confirm-passkey?handoff=${HANDOFF}`]);
    expect(view.container.querySelector("h2")?.textContent).toBe("Confirm in your browser");
    await view.click("Open browser again");
    expect(opened).toHaveLength(2);
    // Nothing to confirm until the person has the code from the browser.
    expect(submit(view.container).disabled).toBe(true);
    await type(view.container, "111 111");
    await view.click("Confirm");
    expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
      "That code isn't right. Check the code your browser shows.",
    );
    expect(sends).toBe(1);
    await type(view.container, "482 913");
    await view.click("Confirm");
    expect(claims).toEqual(["111111", "482913"]);
    expect((await change).status).toBe(200);
    expect(sends).toBe(2);
    // The app never runs a passkey ceremony itself: it would never settle.
    expect(nativeCeremonies).toBe(0);
    expect(view.container.querySelector("[role=dialog]")).toBeNull();
    await view.unmount();
  });

  test("never waits forever: an expired handoff says so and can be cancelled", async () => {
    const { handoff } = browser(20);
    const view = await mount(async () => {}, { handoff });
    const change = withAdminStepUp(async () => refusal(true), {
      input: "/v1/x",
      init: { method: "POST", body: "{}" },
    });
    await flush();
    await view.click("Continue in browser");
    await wait(80);
    expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
      "The confirmation in your browser expired. Try again.",
    );
    expect(view.container.querySelector("h2")?.textContent).toBe("Confirm it's you");
    await view.click("Cancel");
    expect((await change).status).toBe(403);
    await view.unmount();
  });

  test("a server that doesn't answer is reported, and Cancel still works", async () => {
    const { handoff } = browser();
    handoff.start = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    const view = await mount(async () => {}, { handoff });
    const change = withAdminStepUp(async () => refusal(true), {
      input: "/v1/x",
      init: { method: "POST", body: "{}" },
    });
    await flush();
    await view.click("Continue in browser");
    expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
      "The server didn't answer. Check your connection and try again.",
    );
    await view.click("Cancel");
    expect((await change).status).toBe(403);
    await view.unmount();
  });

  test("someone without a passkey adds one in the browser", async () => {
    const { handoff, opened } = browser();
    const view = await mount(async () => {}, { handoff });
    const change = withAdminStepUp(async () => refusal(false), {
      input: "/v1/x",
      init: { method: "POST", body: "{}" },
    });
    await flush();
    await view.click("Add in browser");
    expect((await change).status).toBe(403);
    expect(opened).toEqual([`${window.location.origin}/settings/security`]);
    await view.unmount();
  });
});
