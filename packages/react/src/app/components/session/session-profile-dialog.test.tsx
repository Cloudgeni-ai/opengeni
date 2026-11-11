import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionProfileDialog } = await import("./session-profile-dialog");

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

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("invalid letters keep the dialog open with an error instead of dropping the avatar", async () => {
  const onSubmit = mock(async () => {});
  await act(async () =>
    root.render(
      <SessionProfileDialog
        open
        onOpenChange={() => {}}
        workspaceId="00000000-0000-4000-8000-000000000001"
        seed="chat"
        initial={{
          title: "Release manager",
          description: "",
          avatar: { kind: "letters", letters: "RM", hue: 215 },
        }}
        onSubmit={onSubmit}
      />,
    ),
  );
  const letters = [...document.body.querySelectorAll("input")].find(
    (input) => input.getAttribute("placeholder") === "RM",
  )!;
  expect(letters.value).toBe("RM");
  await typeInto(letters, "R!");
  const save = [...document.body.querySelectorAll("button")].find(
    (button) => button.type === "submit",
  )!;
  await act(async () => {
    save.click();
    await flush();
  });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Use one or two letters or digits.");

  await typeInto(letters, "R2");
  expect(document.body.textContent).not.toContain("Use one or two letters or digits.");
  await act(async () => {
    save.click();
    await flush();
  });
  expect(onSubmit).toHaveBeenCalledWith({
    title: "Release manager",
    description: "",
    avatar: { kind: "letters", letters: "R2", hue: 215 },
  });
});
