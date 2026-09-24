import { expect, jest, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { registerDom } from "../../../../packages/react/test/render-hook";
import { toast } from "sonner";
import { ConnectionPill, CopyableMono } from "./common";

registerDom();

test("transient reconnects do not mount or shift surrounding layout", async () => {
  jest.useFakeTimers();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(<ConnectionPill state="reconnecting" />));
    expect(container.firstElementChild).toBeNull();

    await act(async () => jest.advanceTimersByTime(1_499));
    expect(container.firstElementChild).toBeNull();

    await act(async () => root.render(<ConnectionPill state="live" />));
    await act(async () => jest.advanceTimersByTime(1));
    expect(container.firstElementChild).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
  }
});

test("a stalled reconnect becomes visible after the grace period", async () => {
  jest.useFakeTimers();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(<ConnectionPill state="reconnecting" />));
    expect(container.firstElementChild).toBeNull();

    await act(async () => jest.advanceTimersByTime(1_500));
    expect(container.textContent).toContain("Reconnecting");

    await act(async () => root.render(<ConnectionPill state="live" />));
    await act(async () => root.render(<ConnectionPill state="reconnecting" />));
    expect(container.firstElementChild).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
  }
});

test("copy feedback waits for the clipboard and reports denied access", async () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const success = spyOn(toast, "success").mockImplementation(() => "success");
  const error = spyOn(toast, "error").mockImplementation(() => "error");
  let resolveCopy!: () => void;
  const writeText = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveCopy = resolve;
      }),
  );
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CopyableMono value="organization-id" />));
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith("organization-id");
    expect(success).not.toHaveBeenCalled();
    await act(async () => resolveCopy());
    expect(success).toHaveBeenCalledTimes(1);

    writeText.mockImplementation(() => Promise.reject(new Error("Clipboard denied")));
    await act(async () => button.click());
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Couldn't copy. Select the text and copy it manually.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    success.mockRestore();
    error.mockRestore();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
