import { expect, mock, test } from "bun:test";
import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);
const { MainWindow } = await import("../src/main/window");

function fixture(pageFocused: boolean) {
  const page = {
    focused: pageFocused,
    focusCalls: 0,
    isDestroyed: () => false,
    isFocused: () => page.focused,
    focus() {
      page.focusCalls += 1;
      page.focused = true;
    },
  };
  const window = Object.create(MainWindow.prototype) as any;
  window.window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    focus() {},
  };
  window.shown = { webContents: page };
  window.events = { focused: mock(() => {}) };
  return { window, page };
}

test("the shown page gets keyboard focus back when the window becomes active", () => {
  const { window, page } = fixture(false);
  window.windowFocused();
  expect(page.focusCalls).toBe(1);
  expect(window.events.focused).toHaveBeenCalledTimes(1);
});

test("revealing the window focuses the shown page", () => {
  const { window, page } = fixture(false);
  window.reveal();
  expect(page.focusCalls).toBe(1);
});

test("a page that already has focus is left alone", () => {
  const { window, page } = fixture(true);
  window.windowFocused();
  window.reveal();
  expect(page.focusCalls).toBe(0);
});

test("a window with no page shown still reports focus", () => {
  const { window } = fixture(false);
  window.shown = null;
  window.windowFocused();
  expect(window.events.focused).toHaveBeenCalledTimes(1);
});
