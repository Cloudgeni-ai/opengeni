import { describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { registerDom, renderComponent } from "./render-hook";

registerDom();
const { LightboxProvider, useLightboxGalleryItem, useLightboxOptional } =
  await import("../src/timeline/screenshot-lightbox");
type LightboxGalleryEntry = import("../src/timeline/screenshot-lightbox").LightboxGalleryEntry;
describe("LightboxProvider gallery", () => {
  test("pages through registered chat images in document order, wrapping around", async () => {
    const loads: string[] = [];
    const released: string[] = [];
    let controller: ReturnType<typeof useLightboxOptional> = null;

    function Item({ name, image = true }: { name: string; image?: boolean }) {
      const host = useRef<HTMLDivElement>(null);
      const entry: LightboxGalleryEntry = {
        isImage: async () => image,
        load: async () => {
          loads.push(name);
          return {
            src: `blob:${name}`,
            caption: name,
            release: () => released.push(name),
          };
        },
      };
      useLightboxGalleryItem(host, entry);
      controller = useLightboxOptional();
      return (
        <div ref={host}>
          <button type="button" data-open={name}>
            {name}
          </button>
        </div>
      );
    }

    const rendered = await renderComponent(
      <LightboxProvider>
        <div data-og-timeline-scroller>
          <Item name="first" />
          <Item name="video" image={false} />
          <Item name="second" />
          <Item name="third" />
        </div>
      </LightboxProvider>,
    );
    const source = document.querySelector<HTMLElement>('[data-open="second"]');
    await act(async () => {
      controller?.open("blob:clicked", "second", source, "Image");
    });
    await act(async () => {
      await Promise.resolve();
    });
    const image = () => document.querySelector<HTMLImageElement>("figure img")?.getAttribute("src");
    expect(document.body.textContent).toContain("2 of 3");
    expect(image()).toBe("blob:clicked");

    const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next image"]');
    await act(async () => {
      next?.click();
    });
    expect(image()).toBe("blob:third");
    expect(document.body.textContent).toContain("3 of 3");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(image()).toBe("blob:first");
    expect(document.body.textContent).toContain("1 of 3");
    expect(released).toEqual(["third"]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    expect(image()).toBe("blob:third");
    expect(loads).toEqual(["third", "first", "third"]);
    expect(loads).not.toContain("video");

    await rendered.unmount();
    expect(released).toEqual(["third", "first", "third"]);
  });

  test("a lone image keeps the plain lightbox without paging controls", async () => {
    let controller: ReturnType<typeof useLightboxOptional> = null;
    function Probe() {
      controller = useLightboxOptional();
      return <button type="button" data-open="only" />;
    }
    const rendered = await renderComponent(
      <LightboxProvider>
        <Probe />
      </LightboxProvider>,
    );
    await act(async () => {
      controller?.open("blob:only", undefined, document.querySelector<HTMLElement>("[data-open]"));
    });
    expect(document.querySelector('button[aria-label="Next image"]')).toBeNull();
    expect(document.body.textContent).toContain("Esc or click outside to close");
    await rendered.unmount();
  });
});
