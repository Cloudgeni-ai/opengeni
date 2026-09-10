import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { destructiveActionFocusTarget } from "./confirm-dialog";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe("destructive action focus restoration", () => {
  test("returns the surviving trigger when the destructive action keeps it mounted", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    document.body.append(trigger, fallback);

    expect(destructiveActionFocusTarget(trigger, fallback)).toBe(trigger);

    trigger.remove();
    fallback.remove();
  });

  test("returns a stable logical fallback after the focused trigger is removed", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    fallback.tabIndex = -1;
    document.body.append(trigger, fallback);
    trigger.focus();
    trigger.remove();

    const target = destructiveActionFocusTarget(trigger, fallback);
    target?.focus();

    expect(target).toBe(fallback);
    expect(document.activeElement).toBe(fallback);

    fallback.remove();
  });

  test("uses the logical fallback when the surviving trigger becomes disabled", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    fallback.tabIndex = -1;
    document.body.append(trigger, fallback);
    trigger.disabled = true;

    expect(destructiveActionFocusTarget(trigger, fallback)).toBe(fallback);

    trigger.remove();
    fallback.remove();
  });
});
