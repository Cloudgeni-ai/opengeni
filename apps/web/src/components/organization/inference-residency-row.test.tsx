import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk";

import type { OrganizationAdminIdentity } from "@opengeni/react/app/lib/organization-admin";
import type { OrganizationInferenceResidency } from "@opengeni/react/app/types";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// React DOM loads after the DOM is registered, so later files in the same
// process get working events too.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const SonnerPackage = await import("sonner");
const toastSuccess = mock((_message: string) => undefined);
const toastError = mock((_message: string, _options?: { description?: string }) => undefined);
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: toastSuccess, error: toastError },
  ),
}));
const { InferenceResidencyRow } = await import("./security-page");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const identity: OrganizationAdminIdentity = {
  principalGeneration: 1,
  subjectId: "user:owner",
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

let residency: OrganizationInferenceResidency;
function state(
  euOnly: boolean,
  version: number,
  canTurnOff: boolean,
): OrganizationInferenceResidency {
  return {
    organizationId: identity.organizationId,
    euOnly,
    version,
    updatedAt: version > 0 ? "2026-10-26T12:00:00.000Z" : null,
    canTurnOff,
  };
}
let failWith: Error | null;
let failLoad: Error | null;
const getResidency = mock(async (_organizationId: string) => {
  if (failLoad) {
    const error = failLoad;
    failLoad = null;
    throw error;
  }
  return residency;
});
const updateResidency = mock(
  async (
    _organizationId: string,
    change: { euOnly: boolean; expectedVersion: number; operationId: string },
  ) => {
    if (failWith) throw failWith;
    residency = {
      ...residency,
      euOnly: change.euOnly,
      version: residency.version + 1,
      canTurnOff: change.euOnly,
    };
    return residency;
  },
);
const client = {
  getOrganizationInferenceResidency: getResidency,
  updateOrganizationInferenceResidency: updateResidency,
};
const signInAgain = mock((_onSignedIn: () => void, _onError: (message: string) => void) => {});
const onChanged = mock(() => {});

beforeEach(() => {
  document.body.replaceChildren();
  getResidency.mockClear();
  updateResidency.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  signInAgain.mockClear();
  onChanged.mockClear();
  failWith = null;
  failLoad = null;
  residency = state(false, 3, false);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function render(canTurnOn: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InferenceResidencyRow
        client={client}
        identity={identity}
        canTurnOn={canTurnOn}
        onChanged={onChanged}
        signInAgain={signInAgain}
      />,
    );
    await settle();
  });
  return { container, root };
}

function residencySwitch(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="EU-only inference"]',
  )!;
}

function dialogButton(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent?.trim() === label,
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await settle();
  });
}

test("an owner or admin turns it on in one step, with the version it read", async () => {
  const { container, root } = await render(true);
  expect(container.textContent).toContain("EU-only inference");
  expect(container.textContent).toContain(
    "Models and features run only in the EU. Others are switched off.",
  );
  const control = residencySwitch(container);
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.hasAttribute("aria-disabled")).toBe(false);
  await click(control);
  expect(updateResidency).toHaveBeenCalledTimes(1);
  const [organizationId, change] = updateResidency.mock.calls[0]!;
  expect(organizationId).toBe(identity.organizationId);
  expect(change.euOnly).toBe(true);
  expect(change.expectedVersion).toBe(3);
  expect(change.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("true");
  expect(toastSuccess).toHaveBeenCalledWith("EU-only inference is on");
  await act(async () => root.unmount());
});

test("members see the setting but can't change it", async () => {
  const { container, root } = await render(false);
  const control = residencySwitch(container);
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.getAttribute("aria-disabled")).toBe("true");
  await click(control);
  expect(updateResidency).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("when on, turning off is offered only if the server says canTurnOff", async () => {
  residency = state(true, 4, false);
  const { container, root } = await render(true);
  const control = residencySwitch(container);
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(control.getAttribute("aria-disabled")).toBe("true");
  await click(control);
  expect(updateResidency).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.unmount());
});

test("turning off asks first, and Cancel keeps it on", async () => {
  residency = state(true, 4, true);
  const { container, root } = await render(true);
  await click(residencySwitch(container));
  expect(updateResidency).not.toHaveBeenCalled();
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Turn off EU-only inference?");
  expect(dialog.textContent).toContain(
    "Models and features outside the EU become available again.",
  );
  await click(dialogButton("Cancel")!);
  expect(updateResidency).not.toHaveBeenCalled();
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("true");

  await click(residencySwitch(container));
  await click(dialogButton("Turn off")!);
  expect(updateResidency).toHaveBeenCalledTimes(1);
  expect(updateResidency.mock.calls[0]![1]).toMatchObject({ euOnly: false, expectedVersion: 4 });
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("false");
  expect(toastSuccess).toHaveBeenCalledWith("EU-only inference is off");
  await act(async () => root.unmount());
});

test("a conflict reloads what's true now and says why", async () => {
  const { container, root } = await render(true);
  // Someone else turned it on meanwhile.
  residency = state(true, 5, true);
  failWith = new OpenGeniApiError(
    409,
    JSON.stringify({ message: "EU-only inference changed. Reload and try again." }),
    { mutation: true },
  );
  getResidency.mockClear();
  await click(residencySwitch(container));
  expect(getResidency).toHaveBeenCalledTimes(1);
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("true");
  expect(toastError).toHaveBeenCalledWith("Couldn't change EU-only inference", {
    description: "EU-only inference changed. Reload and try again.",
  });
  await act(async () => root.unmount());
});

test("a deployment that doesn't take changes yet gets a short answer", async () => {
  const { container, root } = await render(true);
  failWith = new OpenGeniApiError(
    503,
    JSON.stringify({ message: "EU-only can't be changed yet." }),
    { mutation: true },
  );
  await click(residencySwitch(container));
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("false");
  expect(toastError).toHaveBeenCalledWith("Couldn't change EU-only inference", {
    description: "It can't be changed yet.",
  });
  await act(async () => root.unmount());
});

test("a failed load offers Try again", async () => {
  failLoad = new OpenGeniApiError(500, "{}", { mutation: false });
  const { container, root } = await render(true);
  expect(container.textContent).toContain("Couldn't load EU-only inference.");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Try again",
  )!;
  await click(retry);
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("false");
  await act(async () => root.unmount());
});

test("turning off without a recent sign-in offers Sign in again, then Turn off", async () => {
  residency = state(true, 4, true);
  const { container, root } = await render(true);
  failWith = new OpenGeniApiError(
    403,
    JSON.stringify({
      code: "forbidden",
      message: "Sign in again to turn EU-only off.",
      details: { code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" },
    }),
    { mutation: true },
  );
  await click(residencySwitch(container));
  await click(dialogButton("Turn off")!);
  // The confirmation stays open with the server's reason and one action.
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Sign in again to turn EU-only off.");
  // A step to take, shown as information rather than a failure.
  const notice = dialog.querySelector('[data-tone="info"]');
  expect(notice?.textContent).toContain("Sign in again to turn EU-only off.");
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(dialogButton("Turn off")).toBeUndefined();
  expect(toastError).not.toHaveBeenCalled();
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("true");

  await click(dialogButton("Sign in again")!);
  expect(signInAgain).toHaveBeenCalledTimes(1);
  expect(updateResidency).toHaveBeenCalledTimes(1);

  // Signed in: Turn off is offered again and now goes through.
  failWith = null;
  await act(async () => {
    signInAgain.mock.calls[0]![0]();
    await settle();
  });
  expect(dialog.textContent).not.toContain("Sign in again to turn EU-only off.");
  await click(dialogButton("Turn off")!);
  expect(updateResidency).toHaveBeenCalledTimes(2);
  expect(residencySwitch(container).getAttribute("aria-checked")).toBe("false");
  expect(toastSuccess).toHaveBeenCalledWith("EU-only inference is off");
  // The open workspace's models and features are read again; the refusal didn't count.
  expect(onChanged).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

test("a sign-in that can't start says why in the confirmation", async () => {
  residency = state(true, 4, true);
  signInAgain.mockImplementationOnce((_onSignedIn, onError) =>
    onError("Couldn't open sign-in. Allow popups for Opengeni and try again."),
  );
  const { container, root } = await render(true);
  failWith = new OpenGeniApiError(
    403,
    JSON.stringify({
      message: "Sign in again to turn EU-only off.",
      details: { code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" },
    }),
    { mutation: true },
  );
  await click(residencySwitch(container));
  await click(dialogButton("Turn off")!);
  await click(dialogButton("Sign in again")!);
  expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain(
    "Couldn't open sign-in. Allow popups for Opengeni and try again.",
  );
  expect(dialogButton("Sign in again")).toBeDefined();
  await act(async () => root.unmount());
});
