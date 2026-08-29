import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { registerDom } from "../../../../packages/react/test/render-hook";
import { ConnectionPill } from "./common";

registerDom();

test("reconnects use the delayed-reveal treatment", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(<ConnectionPill state="reconnecting" />));
  expect(container.textContent).toContain("Reconnecting");
  expect(container.querySelector("span")?.classList).toContain("og-connection-pill-reconnect");

  await act(async () => root.unmount());
  container.remove();
});
