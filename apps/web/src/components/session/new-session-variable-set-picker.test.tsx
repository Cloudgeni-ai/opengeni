import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

let subjectId = "draft-user";
mock.module("@/context", () => ({ useAppContext: () => ({ accessContext: { subjectId } }) }));
const { NewSessionVariableSetPicker } = await import("./new-session-variable-set-picker");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("new-chat save converts priority, restores off rows, and isolates workspace/account transitions", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let runtimeIds = ["low", "high"];
  const onChange = mock((ids: string[]) => {
    runtimeIds = ids;
  });
  const render = (workspaceId = "draft-workspace", key = "one") =>
    root.render(
      <NewSessionVariableSetPicker
        key={key}
        workspaceId={workspaceId}
        runtimeIds={runtimeIds}
        variableSets={[
          { id: "high", name: "High" },
          { id: "low", name: "Low" },
        ]}
        disabled={false}
        onChange={onChange}
      />,
    );
  const click = async (label: string) =>
    act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const action = async (text: string) =>
    act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === text)!
        .click(),
    );
  try {
    await act(async () => render());
    await click("Enable High");
    expect(onChange).not.toHaveBeenCalled();
    await action("Cancel");
    expect(
      container.querySelector('[aria-label="Enable High"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    await click("Move High later");
    await action("Save");
    expect(runtimeIds).toEqual(["high", "low"]);
    await act(async () => render());
    await click("Enable High");
    await action("Save");
    expect(runtimeIds).toEqual(["low"]);
    await act(async () => render("draft-workspace", "reopen"));
    expect(
      container.querySelector('[aria-label="Enable High"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    await click("Remove High");
    await action("Undo");
    expect(
      container.querySelector('[aria-label="Enable High"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    await act(async () => render("another-workspace", "reopen"));
    expect(container.querySelector('[aria-label="Enable High"]')).toBeNull();
    await act(async () => render("draft-workspace", "reopen"));
    expect(container.querySelector('[aria-label="Enable High"]')).not.toBeNull();
    subjectId = "another-user";
    await act(async () => render("draft-workspace", "reopen"));
    expect(container.querySelector('[aria-label="Enable High"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
