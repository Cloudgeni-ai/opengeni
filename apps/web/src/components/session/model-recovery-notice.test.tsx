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

const overloaded = {
  code: "provider_unavailable",
  condition: "overloaded",
  modelLabel: "Claude Opus 5.5",
  providerLabel: "Amazon Bedrock",
  attempt: 2,
  maxAttempts: 5,
  modelRoute: true,
} as const;

test("live status names the model, provider condition and attempt without promising timing", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelRecoveryNotice recovery={overloaded} />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 2 of 5)…",
  );
  expect(container.textContent).toContain(
    "Your message is saved. Opengeni keeps retrying automatically for a few minutes.",
  );
  expect(container.textContent).not.toMatch(/next retry at|reset|\b\d{1,2}:\d{2}\b/i);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("details")).toBeNull();
  await act(async () =>
    root!.render(
      <ModelRecoveryNotice
        recovery={{
          ...overloaded,
          code: "provider_rate_limited",
          condition: "rate_limited",
          modelLabel: null,
          providerLabel: null,
          attempt: null,
        }}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "The model is rate limited at the provider — retrying automatically…",
  );
});

test("recovery does not offer draft-only model changes as a way to unblock the accepted turn", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelRecoveryNotice recovery={overloaded} />));
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).not.toMatch(/another model/i);
});
