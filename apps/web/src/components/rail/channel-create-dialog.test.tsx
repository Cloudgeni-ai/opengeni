import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

let ChannelCreateDialog: typeof import("./channel-create-dialog").ChannelCreateDialog;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ChannelCreateDialog } = await import("./channel-create-dialog"));
});

afterAll(() => GlobalRegistrator.unregister());

describe("project naming dialog", () => {
  for (const mode of ["create", "rename"] as const) {
    test(`${mode} uses the correct label and submits the name`, async () => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      let submissions = 0;
      try {
        await act(async () =>
          root.render(
            <ChannelCreateDialog
              open
              mode={mode}
              name="Existing project"
              busy={false}
              onNameChange={() => {}}
              onOpenChange={() => {}}
              onSubmit={() => {
                submissions++;
              }}
            />,
          ),
        );
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
          mode === "rename" ? "Rename project" : "New project",
        );
        expect(document.querySelector("input")?.value).toBe("Existing project");
        expect(document.querySelector('button[type="submit"]')?.textContent).toContain(
          mode === "rename" ? "Rename" : "Create project",
        );
        await act(async () => {
          document
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        expect(submissions).toBe(1);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }

  for (const fixture of [
    { name: "   ", busy: false },
    { name: "Project", busy: true },
  ]) {
    test(`prevents submission for ${fixture.busy ? "pending saves" : "blank names"}`, async () => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      let submissions = 0;
      try {
        await act(async () =>
          root.render(
            <ChannelCreateDialog
              open
              mode="rename"
              {...fixture}
              onNameChange={() => {}}
              onOpenChange={() => {}}
              onSubmit={() => {
                submissions++;
              }}
            />,
          ),
        );
        expect(
          (document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
        ).toBe(true);
        await act(async () => {
          document
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        expect(submissions).toBe(0);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
});
