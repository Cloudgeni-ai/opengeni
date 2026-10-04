import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelRecoveryNotice } from "./model-recovery-notice";

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Another test already registered the shared DOM.
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

test("live status explains saved work without promising timing or creating another retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelRecoveryNotice recovery={{ kind: "rate_limited" }} />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("This model is busy");
  expect(container.textContent).toContain("Your request is saved. We’ll retry automatically.");
  expect(container.textContent).not.toMatch(/next retry at|reset|\b\d{1,2}:\d{2}\b/i);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("details")).toBeNull();
  await act(async () => root!.render(<ModelRecoveryNotice recovery={{ kind: "unavailable" }} />));
  expect(container.textContent).toContain("The model is temporarily unavailable");
  expect(container.textContent).toContain("Your request is saved. We’ll retry automatically.");
  expect(container.textContent).not.toMatch(/next retry at|reset|\b\d{1,2}:\d{2}\b/i);
  expect(container.textContent).not.toContain("Waiting for the next retry.");
});
