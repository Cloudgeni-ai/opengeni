import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Field, TextArea, TextInput } from "./field";
import { FormFrame, useFormOverlay } from "./form-dialog";

let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const submitButton = () =>
  [...container.querySelectorAll("button")].find((button) => button.type === "submit")!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test("Field binds the label, hint and error to the control", async () => {
  await act(async () =>
    root.render(
      <>
        <Field label="Name" hint="Shown on schedules." optional>
          <TextInput />
        </Field>
        <Field label="Name" error="Name the variable set." hint="Hidden while invalid.">
          <TextInput />
        </Field>
      </>,
    ),
  );
  const [ok, invalid] = [...container.querySelectorAll("input")];
  const [okLabel, invalidLabel] = [...container.querySelectorAll("label")];
  expect(okLabel!.htmlFor).toBe(ok!.id);
  expect(okLabel!.textContent).toBe("NameOptional");
  expect(document.getElementById(ok!.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Shown on schedules.",
  );
  expect(ok!.hasAttribute("aria-invalid")).toBe(false);

  expect(invalidLabel!.htmlFor).toBe(invalid!.id);
  expect(invalid!.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(invalid!.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Name the variable set.",
  );
  expect(container.textContent).not.toContain("Hidden while invalid.");
});

test("a group Field names the group instead of pointing a label at nothing", async () => {
  await act(async () =>
    root.render(
      <Field label="Available to" group hint="You can't change this later.">
        <div>options</div>
      </Field>,
    ),
  );
  const group = container.querySelector('[role="group"]')!;
  expect(container.querySelector("label")).toBeNull();
  expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe(
    "Available to",
  );
});

test("Enter submits; success calls onSubmitted", async () => {
  const submitted = mock();
  const onSubmit = mock(async () => undefined);
  await act(async () =>
    root.render(
      <FormFrame
        title="New variable set"
        submitLabel="Create variable set"
        onSubmit={onSubmit}
        onSubmitted={submitted}
      >
        <Field label="Name">
          <TextInput defaultValue="Sentry" />
        </Field>
      </FormFrame>,
    ),
  );
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(submitted).toHaveBeenCalledTimes(1);
});

test("a save that finishes after the person left the form doesn't close it again", async () => {
  // Closing a form page navigates back to it: a late success must not.
  const submitted = mock();
  let finish!: () => void;
  const onSubmit = mock(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <FormFrame
        title="Where it can be used"
        submitLabel="Save"
        onSubmit={onSubmit}
        onSubmitted={submitted}
      >
        <Field label="Name">
          <TextInput defaultValue="Team plan" />
        </Field>
      </FormFrame>,
    ),
  );
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  // The person navigates elsewhere while the save runs.
  await act(async () => root.render(<p>Another page</p>));
  await act(async () => {
    finish();
    await flush();
  });
  expect(submitted).not.toHaveBeenCalled();
  expect(container.textContent).toBe("Another page");
});

test("a dialog its owner closed during the save can be dismissed again after reopening", async () => {
  // As FormDialog: closing unmounts the form while the overlay stays mounted.
  // The owner closes the confirm and then awaits a refresh (Secrets, Disconnect).
  let finish!: () => void;
  let overlay!: ReturnType<typeof useFormOverlay>;
  let setOpenFromOwner!: (open: boolean) => void;
  const pending: boolean[] = [];
  function Confirm() {
    const [open, setOpen] = useState(true);
    setOpenFromOwner = setOpen;
    overlay = useFormOverlay({
      open,
      onOpenChange: setOpen,
      onPendingChange: (next) => pending.push(next),
    });
    return open ? (
      <FormFrame
        {...overlay.frameProps}
        title="Disconnect"
        submitLabel="Disconnect"
        onSubmit={async () => {
          setOpen(false);
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }}
      >
        <p>Agents here stop using its items.</p>
      </FormFrame>
    ) : null;
  }
  await act(async () => root.render(<Confirm />));
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
    await flush();
  });
  expect(container.querySelector("form")).toBeNull();
  await act(async () => {
    finish();
    await flush();
  });
  expect(pending).toEqual([true, false]);
  await act(async () => setOpenFromOwner(true));
  const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  overlay.contentProps.onEscapeKeyDown(escape);
  const outside = new Event("pointerdown", { cancelable: true });
  overlay.contentProps.onPointerDownOutside(outside);
  expect(escape.defaultPrevented).toBe(false);
  expect(outside.defaultPrevented).toBe(false);
  await act(async () => overlay.rootProps.onOpenChange(false));
  expect(container.querySelector("form")).toBeNull();
});

test("returning false keeps the form open and focuses the first invalid field", async () => {
  const submitted = mock();
  function Invalid() {
    return (
      <FormFrame
        title="New variable set"
        submitLabel="Create variable set"
        onSubmit={() => false}
        onSubmitted={submitted}
      >
        <Field label="Description">
          <TextInput />
        </Field>
        <Field label="Name" error="Name the variable set.">
          <TextInput />
        </Field>
      </FormFrame>
    );
  }
  await act(async () => root.render(<Invalid />));
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
    await flush();
  });
  expect(submitted).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(container.querySelector('[aria-invalid="true"]'));
});

test("a thrown error shows inside the form, and the buttons wait while submitting", async () => {
  let reject: (error: Error) => void = () => undefined;
  const onSubmit = mock(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  await act(async () =>
    root.render(
      <FormFrame
        title="New variable set"
        submitLabel="Create variable set"
        pendingLabel="Creating…"
        onSubmit={onSubmit}
      >
        <Field label="Name">
          <TextInput defaultValue="Sentry" />
        </Field>
      </FormFrame>,
    ),
  );
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
    await flush();
  });
  // Busy, not disabled: the primary keeps focus, and a second press is ignored.
  expect(submitButton().disabled).toBe(false);
  expect(submitButton().getAttribute("aria-disabled")).toBe("true");
  expect(submitButton().textContent).toBe("Creating…");
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(container.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
  const cancel = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )!;
  expect(cancel.disabled).toBe(true);

  await act(async () => {
    reject(new Error("Couldn't create the variable set. Check your connection and try again."));
    await flush();
  });
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(
    "Couldn't create the variable set. Check your connection and try again.",
  );
  expect(submitButton().disabled).toBe(false);
  expect(submitButton().getAttribute("aria-disabled")).toBeNull();
});

test("Cmd or Ctrl + Enter submits from a multi-line field", async () => {
  const onSubmit = mock(() => undefined);
  await act(async () =>
    root.render(
      <FormFrame title="Replace value" submitLabel="Replace value" onSubmit={onSubmit}>
        <Field label="New value">
          <TextArea />
        </Field>
      </FormFrame>,
    ),
  );
  const area = container.querySelector("textarea")!;
  // happy-dom lacks a real submit button activation for requestSubmit from keydown; stub it.
  const form = container.querySelector("form")!;
  form.requestSubmit = () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await act(async () => {
    area.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("a disabled primary says why and who can fix it", async () => {
  await act(async () =>
    root.render(
      <FormFrame
        title="New variable set"
        submitLabel="Create variable set"
        submitDisabled
        disabledReason="Only workspace admins can create variable sets."
      />,
    ),
  );
  const button = submitButton();
  expect(button.disabled).toBe(true);
  expect(document.getElementById(button.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Only workspace admins can create variable sets.",
  );
});

test("Cancel can be hidden for a one-time step", async () => {
  await act(async () =>
    root.render(
      <FormFrame
        title="Copy your new API key"
        submitLabel="I've saved it"
        cancelLabel={null}
        showClose={false}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "I've saved it",
  ]);
});

test("the primary carries only a closed analytics label when one is given", async () => {
  await act(async () =>
    root.render(
      <FormFrame
        variant="page"
        title="New schedule"
        submitLabel="Create schedule"
        submitAnalyticsAction="create_schedule"
      />,
    ),
  );
  expect(submitButton().getAttribute("data-analytics-action")).toBe("create_schedule");

  await act(async () =>
    root.render(
      <FormFrame
        variant="page"
        title="Edit schedule"
        submitLabel="Save changes"
        submitAnalyticsAction={null}
      />,
    ),
  );
  expect(submitButton().hasAttribute("data-analytics-action")).toBe(false);
});
