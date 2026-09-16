import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { variableSetShortlistKey, writeVariableSetShortlist } from "@/lib/variable-set-shortlist";

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
        canAttach
        canUse
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

test.each([
  { canAttach: false, canUse: true },
  { canAttach: true, canUse: false },
])(
  "missing authority %j blocks remembered off rows but allows off/remove cleanup",
  async (authority) => {
    const workspaceId = `permission-test-${authority.canAttach}-${authority.canUse}`;
    writeVariableSetShortlist(variableSetShortlistKey(subjectId, workspaceId, "new-chat"), [
      { id: "remembered-off", enabled: false },
      { id: "stale-on", enabled: true },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = mock((_ids: string[]) => {});
    const render = (key = "initial") =>
      root.render(
        <NewSessionVariableSetPicker
          key={key}
          workspaceId={workspaceId}
          runtimeIds={["stale-on"]}
          variableSets={[]}
          disabled={false}
          {...authority}
          onChange={onChange}
        />,
      );
    const switches = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    const save = () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    try {
      await act(async () => render());
      expect(switches()[0]!.disabled).toBe(true);
      expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
      expect(switches()[1]!.disabled).toBe(false);
      await act(async () => switches()[0]!.click());
      expect(save().disabled).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
      await act(async () => switches()[1]!.click());
      expect(save().disabled).toBe(false);
      await act(async () => save().click());
      expect(onChange).toHaveBeenLastCalledWith([]);
      await act(async () => render("reopen"));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Remove Selected Variable Set 1"]')!
          .click(),
      );
      expect(save().disabled).toBe(false);
      await act(async () => save().click());
      expect(onChange).toHaveBeenLastCalledWith(["stale-on"]);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Remove Selected Variable Set 1"]')!
          .click(),
      );
      await act(async () => save().click());
      expect(onChange).toHaveBeenLastCalledWith([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

test.each([
  { canAttach: false, canUse: true },
  { canAttach: true, canUse: false },
])(
  "permission revocation %j between enabling and Save rejects the pending addition",
  async (revoked) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = mock((_ids: string[]) => {});
    const render = (authority = { canAttach: true, canUse: true }) =>
      root.render(
        <NewSessionVariableSetPicker
          workspaceId={`revoked-${revoked.canAttach}`}
          runtimeIds={[]}
          variableSets={[{ id: "add", name: "Pending set" }]}
          disabled={false}
          {...authority}
          onChange={onChange}
        />,
      );
    const save = () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    try {
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Add variable sets"))!
          .click(),
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Enable Pending set"]')!.click(),
      );
      expect(save().disabled).toBe(false);
      await act(async () => render(revoked));
      expect(save().disabled).toBe(true);
      await act(async () => save().click());
      expect(onChange).not.toHaveBeenCalled();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Enable Pending set"]')!.click(),
      );
      expect(
        container.querySelector('[aria-label="Enable Pending set"]')?.getAttribute("aria-checked"),
      ).toBe("false");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
