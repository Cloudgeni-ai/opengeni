import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerMenuHeader, ComposerMenuSwitch } from "./composer-menu";

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

test("a normal switch requests the opposite state", async () => {
  const change = mock();
  await act(async () =>
    root.render(<ComposerMenuSwitch label="Development" checked onCheckedChange={change} />),
  );
  const button = container.querySelector("button")!;
  expect(button.getAttribute("role")).toBe("switch");
  expect(button.getAttribute("aria-checked")).toBe("true");
  await act(async () => button.click());
  expect(change).toHaveBeenCalledWith(false);
});
test("locked mounted switches remain readable and do not change", async () => {
  const change = mock();
  await act(async () =>
    root.render(
      <ComposerMenuSwitch label="opengeni, mounted" checked locked onCheckedChange={change} />,
    ),
  );
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(change).not.toHaveBeenCalled();
});
test("header keeps title and optional actions in one shared row", async () => {
  await act(async () =>
    root.render(<ComposerMenuHeader title="Variable sets" leading={<button>Back</button>} />),
  );
  expect(container.querySelector("h2")?.textContent).toBe("Variable sets");
  expect(container.querySelector("h2")?.parentElement?.className).toContain("border-b");
});
