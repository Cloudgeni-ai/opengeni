import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { CreditScopeDetails } = await import("./credit-scope-details");

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Another web test in this process already installed Happy DOM.
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

async function openDetails(coversVoice?: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CreditScopeDetails
        label={coversVoice ? "Signup credits" : "Coupon credits"}
        amount="$10.00"
        eligibleModelIds={["gpt-6-sol"]}
        coversVoice={coversVoice}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  return container;
}

test("signup credits list dictation and live voice among what they cover", async () => {
  const container = await openDetails(true);
  expect(container.textContent).toContain("Dictation and live voice");
});

test("model-scoped promotional credits do not claim voice coverage", async () => {
  const container = await openDetails(false);
  expect(container.textContent).not.toContain("Dictation and live voice");
});
