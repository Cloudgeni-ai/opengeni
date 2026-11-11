import { expect, test } from "bun:test";

import { registerDom, renderHook } from "../../../test/render-hook";
import { useFindShortcut } from "./find-shortcut";

registerDom();

function press(target: EventTarget): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

test("a page chat takes Ctrl/⌘+F anywhere on the page", async () => {
  let opened = 0;
  const hook = await renderHook(() => useFindShortcut({ scope: window }, () => opened++), {});
  try {
    expect(press(document.body)).toBe(true);
    expect(opened).toBe(1);
  } finally {
    await hook.unmount();
  }
});

test("a chat in a panel takes it only from inside, so a hidden chat leaves the browser's find alone", async () => {
  const view = document.createElement("main");
  const siteButton = document.createElement("button");
  const panel = document.createElement("aside");
  const chat = document.createElement("div");
  const input = document.createElement("textarea");
  chat.append(input);
  panel.append(chat);
  view.append(siteButton, panel);
  document.body.append(view);
  let opened = 0;
  const open = () => opened++;
  const hook = await renderHook(
    ({ scope }: { scope: EventTarget | null }) => useFindShortcut({ scope }, open),
    { scope: null as EventTarget | null },
  );
  try {
    // Not mounted yet: nothing is taken.
    expect(press(input)).toBe(false);
    await hook.rerender({ scope: chat });
    expect(press(input)).toBe(true);
    expect(opened).toBe(1);
    // Focus on the Site, or nowhere (the chat hidden): the browser keeps find.
    expect(press(siteButton)).toBe(false);
    expect(press(document.body)).toBe(false);
    panel.hidden = true;
    expect(press(document.body)).toBe(false);
    expect(opened).toBe(1);
  } finally {
    await hook.unmount();
    view.remove();
  }
});

test("dialogs and editors inside the chat keep their own find", async () => {
  const chat = document.createElement("div");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const field = document.createElement("input");
  dialog.append(field);
  chat.append(dialog);
  document.body.append(chat);
  let opened = 0;
  const hook = await renderHook(() => useFindShortcut({ scope: chat }, () => opened++), {});
  try {
    expect(press(field)).toBe(false);
    expect(opened).toBe(0);
  } finally {
    await hook.unmount();
    chat.remove();
  }
});
