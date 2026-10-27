import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "https://app.example/settings/organization/security?tab=1" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let selectedSlotId: string | null = "slot-1";
const beginReauth = mock(async (_slotId: string) => ({ transactionId: "t-1" }));
const popupOpen = mock(
  (
    begin: () => Promise<unknown>,
    options?: { onError?: (error: unknown) => void; onSettled?: () => void },
  ) => {
    void begin();
    options?.onSettled?.();
  },
);
const revalidatePrincipalAccess = mock(() => undefined);
const handleManagedSignOut = mock(async () => undefined);
mock.module("@opengeni/react/accounts", () => ({
  useBrowserAccounts: () => ({
    projection: selectedSlotId ? { selectedSlotId } : null,
    beginReauth,
  }),
}));
mock.module("@/components/use-browser-account-popup", () => ({
  useBrowserAccountPopup: () => ({ open: popupOpen }),
}));
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({ revalidatePrincipalAccess, handleManagedSignOut }),
}));
const { useBrowserAccountSignInAgain, useSignOutSignInAgain } = await import("./sign-in-again");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  selectedSlotId = "slot-1";
  for (const fn of [beginReauth, popupOpen, revalidatePrincipalAccess, handleManagedSignOut]) {
    fn.mockClear();
  }
});

async function hookValue<T>(useHook: () => T): Promise<T> {
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  return value!;
}

test("with browser accounts, the selected account signs in again in a sign-in window", async () => {
  const signInAgain = await hookValue(useBrowserAccountSignInAgain);
  const signedIn = mock(() => undefined);
  const failed = mock((_message: string) => undefined);
  signInAgain(signedIn, failed);
  expect(popupOpen).toHaveBeenCalledTimes(1);
  expect(beginReauth).toHaveBeenCalledWith("slot-1");
  expect(revalidatePrincipalAccess).toHaveBeenCalledTimes(1);
  expect(signedIn).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});

test("with no selected account, it says so instead of opening a window", async () => {
  selectedSlotId = null;
  const signInAgain = await hookValue(useBrowserAccountSignInAgain);
  const failed = mock((_message: string) => undefined);
  signInAgain(() => undefined, failed);
  expect(popupOpen).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledWith("Select your account, then try again.");
});

test("without browser accounts, it signs out and comes back to this page", async () => {
  const assign = mock((_url: string) => undefined);
  const original = window.location.assign;
  Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
  try {
    const signInAgain = await hookValue(useSignOutSignInAgain);
    signInAgain(
      () => undefined,
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleManagedSignOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/settings/organization/security?tab=1");
  } finally {
    Object.defineProperty(window.location, "assign", { configurable: true, value: original });
  }
});
