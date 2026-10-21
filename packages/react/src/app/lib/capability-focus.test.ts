import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { findCapabilityFocusTarget, focusCapabilitySuccessor } from "./capability-focus";

GlobalRegistrator.register();

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("capability focus restoration", () => {
  test("successfully moves focus from the removed Browse opener to the Enabled control", () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.dataset.capabilityId = "capability-1";
    document.body.append(opener);
    opener.focus();

    // A successful enable refresh removes the Browse opener and renders the
    // same capability in the Enabled strip.
    opener.remove();
    const enabledControl = document.createElement("button");
    enabledControl.type = "button";
    enabledControl.dataset.capabilityFocusTarget = "";
    enabledControl.dataset.capabilityId = "capability-1";
    enabledControl.setAttribute("aria-label", "Open Example capability");
    document.body.append(enabledControl);

    expect(findCapabilityFocusTarget("capability-1")).toBe(enabledControl);
    expect(focusCapabilitySuccessor("capability-1", null)).toBe(true);
    expect(document.activeElement).toBe(enabledControl);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open Example capability");
  });

  test("does not focus a hidden matching control and uses the visible route fallback", () => {
    const hiddenControl = document.createElement("button");
    hiddenControl.type = "button";
    hiddenControl.dataset.capabilityFocusTarget = "";
    hiddenControl.dataset.capabilityId = "capability-1";
    hiddenControl.hidden = true;
    document.body.append(hiddenControl);

    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    fallback.setAttribute("role", "region");
    fallback.setAttribute("aria-label", "Capabilities");
    document.body.append(fallback);

    expect(findCapabilityFocusTarget("capability-1")).toBeNull();
    expect(focusCapabilitySuccessor("capability-1", fallback)).toBe(true);
    expect(document.activeElement).toBe(fallback);
  });
});
