import { expect, test } from "bun:test";
import { useWindowLayerOpen } from "../src/lib/window-layer";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

function Layer({ open }: { open: boolean }) {
  useWindowLayerOpen(open);
  return null;
}

const marked = () => document.documentElement.hasAttribute("data-window-layer-open");

test("the document is marked while any full-window layer is open", async () => {
  const first = await renderComponent(<Layer open={false} />);
  expect(marked()).toBe(false);
  await first.rerender(<Layer open />);
  expect(marked()).toBe(true);
  // A second layer over the first: closing either one keeps the mark.
  const second = await renderComponent(<Layer open />);
  await first.rerender(<Layer open={false} />);
  expect(marked()).toBe(true);
  await second.unmount();
  expect(marked()).toBe(false);
  await first.unmount();
  expect(marked()).toBe(false);
});
