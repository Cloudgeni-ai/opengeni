import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { registerDom } from "../../../../packages/react/test/render-hook";
import { ConnectionPill } from "./common";

registerDom();

test("brief reconnects do not flash while a stalled reconnect remains visible", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(<ConnectionPill state="live" />));
  await act(async () => root.render(<ConnectionPill state="reconnecting" />));
  expect(container.textContent).toBe("");
  await act(async () => root.render(<ConnectionPill state="live" />));
  expect(container.textContent).toBe("");

  await act(async () => root.render(<ConnectionPill state="reconnecting" />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_550));
  });
  expect(container.textContent).toContain("Reconnecting");

  await act(async () => root.unmount());
  container.remove();
});
