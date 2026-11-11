import { afterEach, describe, expect, test } from "bun:test";

import { Footer } from "../src/components/composer";
import {
  useComposerFooterSignal,
  type ComposerFooterSignal,
} from "../src/lib/composer-footer-signals";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function Signal({ signal, active }: { signal: ComposerFooterSignal; active: boolean }) {
  useComposerFooterSignal(signal, active);
  return <span data-control={signal} />;
}

function footer(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".og-composer-footer")!;
}

describe("composer footer signals", () => {
  test("the footer carries each active control state as its own attribute", async () => {
    mounted = await renderComponent(
      <Footer>
        <Signal signal="transcription-capturing" active={false} />
        <Signal signal="realtime-attention" active />
      </Footer>,
    );
    expect(footer(mounted.container).hasAttribute("data-footer-realtime-attention")).toBe(true);
    expect(footer(mounted.container).hasAttribute("data-footer-transcription-capturing")).toBe(
      false,
    );

    await mounted.rerender(
      <Footer>
        <Signal signal="transcription-capturing" active />
        <Signal signal="realtime-attention" active={false} />
      </Footer>,
    );
    expect(footer(mounted.container).hasAttribute("data-footer-realtime-attention")).toBe(false);
    expect(footer(mounted.container).hasAttribute("data-footer-transcription-capturing")).toBe(
      true,
    );
  });

  test("a control that unmounts clears its state", async () => {
    mounted = await renderComponent(
      <Footer>
        <Signal signal="transcription-attention" active />
      </Footer>,
    );
    expect(footer(mounted.container).hasAttribute("data-footer-transcription-attention")).toBe(
      true,
    );
    await mounted.rerender(<Footer />);
    expect(footer(mounted.container).hasAttribute("data-footer-transcription-attention")).toBe(
      false,
    );
  });

  test("a control outside a footer is a no-op", async () => {
    mounted = await renderComponent(<Signal signal="realtime-attention" active />);
    expect(mounted.container.querySelector("[data-control]")).not.toBeNull();
  });
});
