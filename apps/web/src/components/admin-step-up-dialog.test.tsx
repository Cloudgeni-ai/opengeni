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
mock.module("@/api", () => ({ AuthApiError, confirmAdminWithPasskey: async () => {} }));
// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@opengeni/react/ui/form-dialog", () => ({
  FormDialog: ({
    title,
    description,
    submitLabel,
    error,
    onOpenChange,
    onSubmit,
  }: {
    title: ReactNode;
    description?: ReactNode;
    submitLabel: ReactNode;
    error?: ReactNode;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => unknown;
  }) => (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
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
const { withAdminStepUp } = await import("@/lib/admin-step-up");
const { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } =
  await import("@opengeni/contracts/managed-sign-in-methods");

beforeAll(() => {
  GlobalRegistrator.register();
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

async function mount(confirm: () => Promise<void>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminStepUpDialog confirm={confirm} />));
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
    await view.click("Add passkey");
    expect((await change).status).toBe(403);
    expect(navigations).toEqual([{ to: "/settings/security" }]);
    await view.unmount();
  });
});
