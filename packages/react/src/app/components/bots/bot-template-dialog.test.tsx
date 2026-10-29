import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BotTemplateDialog } = await import("./bot-template-dialog");

afterAll(() => GlobalRegistrator.unregister());
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;

test("a template saved from an Only me chat starts Only me, and the person can share it", async () => {
  const onSubmit = mock(async () => {});
  await act(async () =>
    root.render(
      <BotTemplateDialog
        open
        onOpenChange={() => {}}
        workspaceId="00000000-0000-4000-8000-000000000001"
        seed="chat"
        mode="save"
        initial={{
          name: "Inbox bot",
          description: "",
          avatar: null,
          setupInstructions: "Sort my inbox every morning.",
          visibility: "private",
        }}
        onSubmit={onSubmit}
      />,
    ),
  );
  expect(document.body.textContent).toContain("Who can use it");
  expect(button("Only me").getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Only you see it in Bot templates.");

  await act(async () => {
    button("Everyone in the workspace").click();
    await flush();
  });
  expect(document.body.textContent).toContain("Everyone in this workspace can start bots from it.");
  await act(async () => {
    button("Save template").click();
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledWith({
    name: "Inbox bot",
    description: "",
    avatar: null,
    setupInstructions: "Sort my inbox every morning.",
    visibility: "workspace",
  });
});
