import { describe, expect, test } from "bun:test";

import { registerDom, renderComponent } from "../../../test/render-hook";
import {
  SessionUiFeaturesProvider,
  useSessionUiFeature,
  type SessionUiFeatureOverrides,
  type SessionUiPreset,
} from "./session-ui-features";

registerDom();

async function addCreditsIn(options: {
  preset?: SessionUiPreset;
  features?: SessionUiFeatureOverrides;
  provider?: boolean;
}) {
  const captured: { current: boolean | null } = { current: null };
  function Capture() {
    captured.current = useSessionUiFeature("addCredits");
    return null;
  }
  const rendered = await renderComponent(
    options.provider === false ? (
      <Capture />
    ) : (
      <SessionUiFeaturesProvider preset={options.preset} features={options.features}>
        <Capture />
      </SessionUiFeaturesProvider>
    ),
  );
  await rendered.unmount();
  return captured.current;
}

describe("the new-chat page's Add credits button", () => {
  test("shows in the web app, with or without a provider", async () => {
    expect(await addCreditsIn({ provider: false })).toBe(true);
    expect(await addCreditsIn({ preset: "app" })).toBe(true);
  });

  test("is off in first-party side panes such as the Excel add-in", async () => {
    expect(await addCreditsIn({ preset: "companion" })).toBe(false);
  });

  test("stays on for customer embeds unless the host switches it off", async () => {
    expect(await addCreditsIn({ preset: "embed" })).toBe(true);
    expect(await addCreditsIn({ preset: "embed", features: { addCredits: false } })).toBe(false);
  });
});
