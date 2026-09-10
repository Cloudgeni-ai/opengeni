import { expect, jest, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { registerDom } from "../../../../packages/react/test/render-hook";
import { ConnectionPill } from "./common";

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
