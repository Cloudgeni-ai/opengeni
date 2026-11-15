import { expect, mock, test } from "bun:test";
import { useState } from "react";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const { FormDialog, FormPage } = await import("../src/ui/form-dialog");

test("confirming a dialog opened from a form field doesn't submit that form", async () => {
  const outer = mock(async () => true);
  const confirmed = mock(() => {});
  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <FormPage title="Add people" submitLabel="Add" onSubmit={outer}>
        <p>Role</p>
        {open ? (
          <FormDialog
            open
            onOpenChange={setOpen}
            title="Make this person an admin?"
            submitLabel="Make admin"
            onSubmit={() => {
              confirmed();
              setOpen(false);
            }}
          />
        ) : null}
      </FormPage>
    );
  }
  const view = await renderComponent(<Page />);
  try {
    await flush();
    const forms = [...document.querySelectorAll("form")];
    expect(forms.length).toBe(2);
    const dialogForm = forms.find((form) => form.closest('[role="dialog"]'))!;
    await actRun(() =>
      dialogForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});
