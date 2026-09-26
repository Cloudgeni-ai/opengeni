import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SegmentedControl } from "./segmented-control";
import {
  SettingRow,
  SettingRowGroup,
  SettingRowSkeleton,
  useSettingRowControl,
  useSettingRowField,
} from "./setting-row";
import { Switch } from "./switch";
import { TooltipProvider } from "./tooltip";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return {
    container,
    rerender: (next: ReactNode) =>
      act(async () => root.render(<TooltipProvider>{next}</TooltipProvider>)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function textOf(ids: string | null) {
  return (ids ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent);
}

describe("SettingRow", () => {
  test("names and describes its control, including hint and error", async () => {
    const view = await render(
      <SettingRow
        label="Video generation"
        description="Let agents create short video clips in chats."
        hint="Connect AI Gateway"
        error="Couldn't save your change."
        control={<Switch />}
      />,
    );
    try {
      const control = view.container.querySelector('[role="switch"]')!;
      expect(textOf(control.getAttribute("aria-labelledby"))).toEqual(["Video generation"]);
      expect(textOf(control.getAttribute("aria-describedby"))).toEqual([
        "Let agents create short video clips in chats.",
        "Connect AI Gateway",
        "Couldn't save your change.",
      ]);
      const label = view.container.querySelector("label")!;
      expect(label.htmlFor).toBe(control.id);
    } finally {
      await view.unmount();
    }
  });

  test("clicking the label toggles the switch", async () => {
    const view = await render(<SettingRow label="Voice input" control={<Switch />} />);
    try {
      const control = view.container.querySelector('[role="switch"]')!;
      await act(async () => view.container.querySelector("label")!.click());
      expect(control.getAttribute("aria-checked")).toBe("true");
    } finally {
      await view.unmount();
    }
  });

  test("sub-rows render inside the parent and only when given", async () => {
    const row = (on: boolean) => (
      <SettingRowGroup>
        <SettingRow label="Voice input" control={<Switch checked={on} />}>
          {on ? <SettingRow label="Transcription provider" controlWidth="select" /> : null}
        </SettingRow>
        <SettingRow label="Fast code search" />
      </SettingRowGroup>
    );
    const view = await render(row(true));
    try {
      const group = view.container.querySelector('[data-slot="setting-row-group"]')!;
      // Two top-level rows: the sub-row lives inside Voice input, so no divider splits them.
      expect(group.children).toHaveLength(2);
      const nested = view.container.querySelector('[data-slot="setting-row-children"]');
      expect(nested?.textContent).toContain("Transcription provider");
      expect(nested?.querySelector('[data-slot="setting-row"]')?.hasAttribute("data-nested")).toBe(
        true,
      );
      await view.rerender(row(false));
      expect(view.container.querySelector('[data-slot="setting-row-children"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("control placement follows the variant", () => {
    const html = (variant: "control-right" | "control-left" | "stacked") =>
      renderToStaticMarkup(
        <SettingRow variant={variant} label="Voice input" control={<span data-control />} />,
      );
    const order = (markup: string) =>
      markup.indexOf("data-control") < markup.indexOf("Voice input")
        ? "control-first"
        : "text-first";
    expect(order(html("control-left"))).toBe("control-first");
    expect(order(html("control-right"))).toBe("text-first");
    expect(order(html("stacked"))).toBe("text-first");
    expect(html("stacked")).toContain("grid-cols-1");
  });

  test("custom controls can take the field ids", async () => {
    function CustomControl() {
      const field = useSettingRowControl();
      return <button type="button" id={field?.controlId} aria-labelledby={field?.labelId} />;
    }
    const view = await render(
      <SettingRow label="Transcription provider" control={<CustomControl />} />,
    );
    try {
      const button = view.container.querySelector("button")!;
      expect(textOf(button.getAttribute("aria-labelledby"))).toEqual(["Transcription provider"]);
      expect(view.container.querySelector("label")!.htmlFor).toBe(button.id);
    } finally {
      await view.unmount();
    }
  });

  test("the label only points at a control that took its id", async () => {
    function NamedOnly() {
      const field = useSettingRowField();
      return <button type="button" aria-labelledby={field?.labelId} />;
    }
    const view = await render(
      <SettingRowGroup>
        <SettingRow label="Pause" control={<NamedOnly />} />
        <SettingRow
          label="Fast code search"
          controlWidth="auto"
          control={
            <SegmentedControl
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          }
        />
      </SettingRowGroup>,
    );
    try {
      for (const label of view.container.querySelectorAll("label")) {
        expect(label.hasAttribute("for")).toBe(false);
      }
      expect(
        view.container.querySelector('[role="radiogroup"]')!.getAttribute("aria-labelledby"),
      ).toBe(view.container.querySelectorAll("label")[1]!.id);
    } finally {
      await view.unmount();
    }
  });

  test("control left keeps one text column for rows without a leading switch", () => {
    const html = renderToStaticMarkup(
      <SettingRow
        variant="control-left"
        label="Fast code search"
        controlWidth="auto"
        control={<span />}
      />,
    );
    expect(html).toContain("*:col-start-2");
  });

  test("the skeleton is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<SettingRowSkeleton controlWidth="select" />);
    expect(html).toContain('aria-hidden="true"');
  });
});
