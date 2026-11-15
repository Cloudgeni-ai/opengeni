import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Radix portals only mount when a DOM exists at import time, so import after registering.
let FormDialog: typeof import("./form-dialog").FormDialog;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ FormDialog } = await import("./form-dialog"));
});

afterAll(() => GlobalRegistrator.unregister());

test("aboveOtherDialogs raises the overlay and the dialog, and is off by default", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const layers = () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const overlay = dialog.previousElementSibling as HTMLElement;
    return [overlay.style.zIndex, dialog.style.zIndex];
  };
  const render = (aboveOtherDialogs: boolean) =>
    act(async () =>
      root.render(
        <FormDialog
          open
          onOpenChange={() => {}}
          title="Confirm it's you"
          submitLabel="Continue"
          aboveOtherDialogs={aboveOtherDialogs}
        />,
      ),
    );
  try {
    await render(false);
    expect(layers()).toEqual(["", ""]);
    await render(true);
    expect(layers()).toEqual(["1100", "1100"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
