import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// The Radix dialog is a portal; these inline stand-ins keep its contract.
const part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@opengeni/react/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: ReactNode;
  }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: part,
  DialogHeader: part,
  DialogFooter: part,
  DialogTitle: part,
  DialogDescription: part,
}));

const { SlackLinkLinkedDialog } = await import("./routes/workspace");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

describe("Slack link outcome for someone in the workspace", () => {
  test("says it's linked and to go back to Slack until they close it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let done = 0;
    await act(async () => {
      root.render(<SlackLinkLinkedDialog open onDone={() => (done += 1)} />);
      await Promise.resolve();
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Linked.");
    expect(dialog?.textContent).toContain("Go back to Slack and ask again.");
    const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual(["Done"]);
    await act(async () => {
      buttons[0]!.click();
      await Promise.resolve();
    });
    expect(done).toBe(1);
    await act(async () => root.unmount());
  });
});
