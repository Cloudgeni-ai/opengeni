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
  test("creates a project with the typed name", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let submissions = 0;
    try {
      await act(async () =>
        root.render(
          <ChannelCreateDialog
            open
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
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("New project");
      expect(document.querySelector("input")?.value).toBe("Existing project");
      expect(document.querySelector('button[type="submit"]')?.textContent).toContain(
        "Create project",
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

  test("offers Only me only where it is allowed, and says who sees the project", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const chosen: string[] = [];
    const render = (audience: Parameters<typeof ChannelCreateDialog>[0]["audience"]) =>
      act(async () =>
        root.render(
          <ChannelCreateDialog
            open
            name="Plans"
            busy={false}
            audience={audience}
            onNameChange={() => {}}
            onOpenChange={() => {}}
            onSubmit={() => {}}
          />,
        ),
      );
    const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
    try {
      // Not offered (a Personal workspace, or Only me is off): no choice.
      await render(undefined);
      expect(dialogText()).not.toContain("Who can see it");
      expect(dialogText()).toContain("for everyone in this workspace");

      await render({ value: "workspace", onChange: (value) => chosen.push(value) });
      expect(dialogText()).toContain("Who can see it");
      expect(dialogText()).toContain("Everyone in this workspace sees it.");
      const onlyMe = [...document.querySelectorAll('[role="dialog"] button')].find(
        (button) => button.textContent === "Only me",
      ) as HTMLButtonElement;
      await act(async () => {
        onlyMe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(chosen).toEqual(["private"]);

      await render({ value: "private", onChange: () => {} });
      expect(dialogText()).toContain("Only you see it. It holds your Only me chats and Sites.");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
