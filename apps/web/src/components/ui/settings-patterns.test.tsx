import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChoiceGroup,
  ListToolbar,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  ToggleSetting,
} from "./settings-patterns";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("switch is labeled, controlled, and locked while saving", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let next: boolean | undefined;
  try {
    await act(async () =>
      root.render(
        <SettingsSwitch
          aria-label="Retain knowledge"
          checked={false}
          onCheckedChange={(value) => {
            next = value;
          }}
        />,
      ),
    );
    const control = container.querySelector("button")!;
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    await act(async () => control.click());
    expect(next).toBe(true);
    await act(async () =>
      root.render(
        <SettingsSwitch
          aria-label="Retain knowledge"
          checked
          saving
          onCheckedChange={() => {
            throw new Error("Saving switch must not run");
          }}
        />,
      ),
    );
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("true");
    control.click();
  } finally {
    await act(async () => root.unmount());
  }
});

test("toggle description is associated with its control", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <ToggleSetting
      title="Learning"
      description="Review before publishing"
      checked
      onCheckedChange={() => {}}
    />,
  );
  const control = container.querySelector("button")!;
  const id = control.getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  expect(
    [...container.querySelectorAll("[id]")].find((element) => element.id === id)?.textContent,
  ).toBe("Review before publishing");
});

test("choice groups use native mutually exclusive keyboard-accessible radios", () => {
  const html = renderToStaticMarkup(
    <ChoiceGroup
      label="Learning"
      value="review"
      onChange={() => {}}
      options={[
        { value: "off", label: "Off", description: "No learning" },
        { value: "review", label: "Review", description: "Review changes" },
      ]}
    />,
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  const radios = [...container.querySelectorAll("input")];
  expect(radios).toHaveLength(2);
  expect(radios[0]!.name).toBe(radios[1]!.name);
  expect(radios[0]!.checked).toBe(false);
  expect(radios[1]!.checked).toBe(true);
});

test("list search has an accessible label and sections preserve one row boundary", () => {
  const html = renderToStaticMarkup(
    <>
      <ListToolbar query="" onQueryChange={() => {}} placeholder="Search members" />
      <SettingsSection title="Members">
        <SettingsRow title="Alex" description="Owner" />
      </SettingsSection>
    </>,
  );
  expect(html).toContain('aria-label="Search members"');
  expect(html).toContain('type="search"');
  expect(html).toContain('data-slot="settings-row"');
  expect(html).toContain("aria-labelledby=");
});
