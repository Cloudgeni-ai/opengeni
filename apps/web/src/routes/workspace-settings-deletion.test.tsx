import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const { DangerZone } = await import("./workspace-settings");

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          input as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) onChange({ target: input });
    else input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("workspace deletion confirmation", () => {
  test("submits only once while a deletion request is pending", async () => {
    const pending = deferred<boolean>();
    const onDelete = mock(() => pending.promise);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <DangerZone
            workspaceName="Workspace A"
            canDelete
            isOnlyWorkspaceInAccount={false}
            onDelete={onDelete}
          />,
        );
      });

      await act(async () => {
        container.querySelector<HTMLButtonElement>("button")!.click();
      });

      const input = document.body.querySelector<HTMLInputElement>("#confirm-workspace-name")!;
      await setInputValue(input, "Workspace A");

      const form = input.closest("form")!;
      await act(async () => {
        form.requestSubmit();
        form.requestSubmit();
        await Promise.resolve();
      });

      expect(onDelete).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(false);
        await pending.promise;
      });
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    } finally {
      pending.resolve(false);
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
