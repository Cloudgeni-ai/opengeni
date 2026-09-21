import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NEW_SESSION_STARTERS, NewSessionStarters } from "./new-session-starters";

let priorActEnvironmentDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  priorActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  try {
    GlobalRegistrator.unregister();
  } finally {
    if (priorActEnvironmentDescriptor) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironmentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  }
});

test("six always-visible suggestions emit only editable prompt text on explicit click", async () => {
  const onSelect = mock((_prompt: string) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NewSessionStarters onSelect={onSelect} />));
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector("h2")?.textContent).toBe("Suggestions");
    expect(container.querySelectorAll("button")).toHaveLength(6);
    expect(container.querySelector("select, [role=combobox], details, a")).toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    for (const [index, starter] of NEW_SESSION_STARTERS.entries()) {
      const button = buttons[index]!;
      expect(button.type).toBe("button");
      expect(button.textContent).toBe(starter.title + starter.description);
      expect(button.classList.contains("h-full")).toBe(true);
      await act(async () => button.click());
      expect(onSelect.mock.calls[index]).toEqual([starter.prompt]);
    }
    expect(onSelect).toHaveBeenCalledTimes(6);
    const marks = buttons.map((button) => button.querySelector("img, svg")!);
    expect(marks.slice(0, 3).every((mark) => mark.classList.contains("size-8"))).toBe(true);
    expect(marks.slice(3).every((mark) => mark.classList.contains("size-5"))).toBe(true);
    expect(marks.every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(marks[1]!.getAttribute("fill")).toBe("currentColor");
    expect(buttons[0]!.parentElement?.classList.contains("auto-rows-fr")).toBe(true);

    await act(async () => root.render(<NewSessionStarters onSelect={onSelect} disabled />));
    expect(container.querySelectorAll("button:disabled")).toHaveLength(6);
    await act(async () => container.querySelector("button")!.click());
    expect(onSelect).toHaveBeenCalledTimes(6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("route keeps suggestions below recent sessions and uses the ordinary draft/send boundary", () => {
  const route = readFileSync(new URL("../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(route.indexOf("<NewSessionStarters")).toBeGreaterThan(route.indexOf("<RecentSessions"));
  expect(route).toContain('data-workspace-scroll-owner="self-managed"');
  expect(route).toContain("[&_textarea]:min-h-[calc(2lh+1rem)]");
  expect(route).toContain('querySelector("textarea")?.focus({ preventScroll: true })');
  expect(route).toContain("setMessage(prompt)");
  expect(route).toContain("value: message");
  expect(route).toContain("setValue: setMessage");
  expect(route).toContain("<SessionVisibilityPicker");
  expect(route).toContain("<ComputeTargetControl");
});
