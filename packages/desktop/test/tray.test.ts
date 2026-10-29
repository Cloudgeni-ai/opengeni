import { describe, expect, mock, test } from "bun:test";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

const { trayMenu } = await import("../src/main/tray");
type Summary = Parameters<typeof trayMenu>[0];

function menu(summary: Partial<Summary>) {
  const opened: string[] = [];
  const actions = {
    open: () => opened.push("open"),
    pause: () => opened.push("pause"),
    resume: () => opened.push("resume"),
    allow: (permission: string) => opened.push(permission),
    quit: () => opened.push("quit"),
  };
  const result = trayMenu(
    { installed: true, connected: true, running: true, ...summary },
    "Product",
    actions,
  );
  const labels = result.template.map((item) => item.label).filter(Boolean);
  const click = (label: string) => {
    const item = result.template.find((entry) => entry.label === label);
    (item?.click as (() => void) | undefined)?.();
    return opened;
  };
  return { ...result, labels, click };
}

describe("menu bar status of this computer", () => {
  test("a refused sign-in says it needs reconnecting, with one way to do it", () => {
    const refused = menu({ reconnecting: true, needsReconnect: true });
    expect(refused.labels[0]).toBe("This computer: needs reconnecting");
    expect(refused.toolTip).toBe("Product: this computer needs reconnecting");
    expect(refused.labels).not.toContain("This computer: connecting…");
    expect(refused.labels).toContain("Reconnect This Computer…");
    expect(refused.click("Reconnect This Computer…")).toEqual(["open"]);
  });

  test("still starting up is connecting, with nothing to do", () => {
    const starting = menu({ reconnecting: true });
    expect(starting.labels[0]).toBe("This computer: connecting…");
    expect(starting.toolTip).toBe("Product: connecting this computer…");
    expect(starting.labels).not.toContain("Reconnect This Computer…");
  });

  test("available, paused and missing permissions read as before", () => {
    expect(menu({}).labels[0]).toBe("This computer: available to agents");
    const paused = menu({ running: false, needsReconnect: false });
    expect(paused.labels[0]).toBe("This computer: paused");
    expect(paused.labels).toContain("Resume This Computer");
    const missing = menu({ missingPermissions: ["accessibility"] });
    expect(missing.labels[0]).toBe("This computer: screen control needs permission");
    expect(missing.labels).toContain("Allow Accessibility…");
  });

  test("a computer that isn't connected only offers the window and quitting", () => {
    const none = menu({ connected: false, running: false });
    expect(none.labels).toEqual(["Open Product", "Quit Product"]);
    expect(none.toolTip).toBe("Product");
  });
});
