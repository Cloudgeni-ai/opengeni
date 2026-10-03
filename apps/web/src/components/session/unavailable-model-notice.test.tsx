import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { UnavailableModelNotice } from "./unavailable-model-notice";

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* shared DOM */
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
async function render(children: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(children));
  return container;
}

test("names the unavailable model and the preselected replacement", async () => {
  let chosen = 0;
  const container = await render(
    <UnavailableModelNotice
      modelName="nemotron-3-super-120b-a12b"
      replacementLabel="GPT-6 Astra"
      canChooseModel
      onChooseModel={() => (chosen += 1)}
    />,
  );
  const notice = container.querySelector('[data-testid="unavailable-model-notice"]')!;
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.textContent).toContain(
    "This chat's model (nemotron-3-super-120b-a12b) is no longer available.",
  );
  expect(notice.textContent).toContain("Your next message will use GPT-6 Astra.");
  expect(notice.textContent).not.toMatch(/422|Retry/);
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("Change model");
  await act(async () => button.click());
  expect(chosen).toBe(1);
});

test("asks for a model when none is selected and hides the action when the picker is disabled", async () => {
  const container = await render(
    <UnavailableModelNotice
      modelName="GPT-6 Luna"
      replacementLabel={null}
      canChooseModel
      onChooseModel={() => {}}
    />,
  );
  expect(container.textContent).toContain("Choose another model to continue.");
  expect(container.querySelector("button")!.textContent).toBe("Choose model");
  await act(async () =>
    root!.render(
      <UnavailableModelNotice
        modelName="GPT-6 Luna"
        replacementLabel={null}
        canChooseModel={false}
        onChooseModel={() => {}}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
});
