import { describe, expect, test } from "bun:test";
import type { Workspace } from "@opengeni/contracts";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentActivityRow } from "./agent-activity";

type Control = Workspace["inferenceControl"];

function control(overrides: Partial<Control>): Control {
  return { state: "active", revision: 1, timer: null, ...overrides } as Control;
}

const noop = async () => undefined;

function render(state: Partial<Control>, canManage = true) {
  return renderToStaticMarkup(
    <AgentActivityRow
      control={control(state)}
      canManage={canManage}
      onControl={noop}
      onTimer={noop}
      onRefresh={noop}
    />,
  );
}

describe("AgentActivityRow", () => {
  test("running: a plain Pause button, not a menu button", () => {
    const html = render({ state: "active" });
    expect(html).toContain("Running");
    expect(html).toMatch(/<button[^>]*>.*Pause<\/button>/);
    expect(html).not.toContain("…");
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  test("paused: Change and Resume", () => {
    const html = render({ state: "paused" });
    expect(html).toContain("Paused");
    expect(html).toMatch(/>Change<\/button>/);
    expect(html).toMatch(/Resume<\/button>/);
  });

  test("without permission, the one button is disabled with the reason", () => {
    const html = render({ state: "paused" }, false);
    expect(html).not.toContain(">Change<");
    expect(html).toContain('aria-disabled="true"');
  });
});
