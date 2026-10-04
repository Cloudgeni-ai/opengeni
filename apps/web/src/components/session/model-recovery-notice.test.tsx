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
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "High demand right now",
  );
  expect(container.textContent).toContain(
    "Some models are being throttled. Your message is saved and we’ll keep retrying for a few minutes.",
  );
  expect(container.textContent).not.toMatch(/next retry at|reset|\b\d{1,2}:\d{2}\b/i);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("details")).toBeNull();
  await act(async () => root!.render(<ModelRecoveryNotice recovery={{ kind: "unavailable" }} />));
  expect(container.textContent).toContain("This model is temporarily unavailable");
  expect(container.textContent).toContain(
    "Your message is saved and we’ll keep retrying for a few minutes.",
  );
  expect(container.textContent).not.toContain("throttled");
  expect(container.textContent).not.toMatch(/choose another model/i);
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).not.toMatch(/next retry at|reset|\b\d{1,2}:\d{2}\b/i);
  expect(container.textContent).not.toContain("Waiting for the next retry.");
});

test("recovery does not offer draft-only model changes as a way to unblock the accepted turn", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelRecoveryNotice recovery={{ kind: "rate_limited" }} />));
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).not.toContain("choose another model");
});
