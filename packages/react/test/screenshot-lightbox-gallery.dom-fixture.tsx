import { describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { registerDom, renderComponent } from "./render-hook";

registerDom();
const { LightboxProvider, useLightboxGalleryItem, useLightboxOptional } =
  await import("../src/timeline/screenshot-lightbox");
type LightboxGalleryEntry = import("../src/timeline/screenshot-lightbox").LightboxGalleryEntry;
type LightboxGalleryImage = import("../src/timeline/screenshot-lightbox").LightboxGalleryImage;

/**
 * Gives the zoom surface a 1000 x 800 CSS-pixel layout box (its size) at the
 * window's origin (its position); returns the restore function.
 */
function measureZoomSurface(width = 1000, height = 800): () => void {
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const isSurface = (element: HTMLElement) => element.hasAttribute("data-zoom-pan-surface");
  const own = {
    clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
  };
  const inherited = (name: "clientWidth" | "clientHeight") => {
    for (let level = Object.getPrototypeOf(proto); level; level = Object.getPrototypeOf(level)) {
      const descriptor = Object.getOwnPropertyDescriptor(level, name);
      if (descriptor) return descriptor;
    }
    return undefined;
  };
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (!isSurface(this)) return rect.call(this);
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  for (const [name, size] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    const original = own[name] ?? inherited(name);
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return isSurface(this) ? size : ((original?.get?.call(this) as number | undefined) ?? 0);
      },
    });
  }
  return () => {
    proto.getBoundingClientRect = rect;
    for (const name of ["clientWidth", "clientHeight"] as const) {
      const descriptor = own[name];
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else Reflect.deleteProperty(proto, name);
    }
  };
}

describe("LightboxProvider gallery", () => {
  /** Opens a lone image of the given pixel size in a 1000 x 800 image area. */
  async function openLoneImage(naturalWidth: number, naturalHeight: number) {
    let controller: ReturnType<typeof useLightboxOptional> = null;
    function Probe() {
      controller = useLightboxOptional();
      return <button type="button" data-open="only" />;
    }
    const restore = measureZoomSurface();
    const rendered = await renderComponent(
      <LightboxProvider>
        <Probe />
      </LightboxProvider>,
    );
    await act(async () => {
      controller?.open("blob:only", undefined, document.querySelector<HTMLElement>("[data-open]"));
    });
    const image = document.querySelector<HTMLImageElement>("figure img")!;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: naturalWidth });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: naturalHeight });
    await act(async () => {
      image.dispatchEvent(new Event("load"));
    });
    return {
      image,
      surface: document.querySelector<HTMLElement>("[data-zoom-pan-surface]")!,
      percent: () => document.querySelector("[data-zoom-percent]")?.textContent,
      open: () => document.querySelector('[role="dialog"]')?.getAttribute("data-state") === "open",
      async cleanup() {
        restore();
        await rendered.unmount();
      },
    };
  }

  /** A mouse press and release at one point, as a click on the zoom surface. */
  async function clickAt(target: Element, x: number, y: number) {
    for (const type of ["pointerdown", "pointerup"] as const) {
      await act(async () => {
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
      });
    }
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    });
  }

  test("a click beside the image closes the viewer at any zoom and never zooms it", async () => {
    // 600 x 400 pixels, enlarged to fit at 161%, as in the reported case (126%).
    const lightbox = await openLoneImage(600, 400);
    try {
      expect(lightbox.percent()).toBe("161%");
      // A click on the image shrinks it to actual size, 600 x 400 at (200, 200).
      await clickAt(lightbox.surface, 500, 400);
      expect(lightbox.percent()).toBe("100%");
      expect(lightbox.open()).toBe(true);
      // The dark backdrop right beside the image closes it; it does not zoom back.
      await clickAt(lightbox.surface, 150, 400);
      expect(lightbox.percent()).toBe("100%");
      expect(lightbox.open()).toBe(false);
    } finally {
      await lightbox.cleanup();
    }
  });

  test("the zoom cursor shows what a click on the image will do, and only on the image", async () => {
    const lightbox = await openLoneImage(600, 400);
    const cursor = (element: Element) =>
      [...element.classList].filter((name) => name.startsWith("cursor-"));
    try {
      // Enlarged to fit: a click shrinks it.
      expect(cursor(lightbox.image)).toEqual(["cursor-zoom-out"]);
      expect(lightbox.image.getAttribute("data-zoom-click")).toBe("out");
      await clickAt(lightbox.surface, 500, 400);
      // At actual size: the next click enlarges it again.
      expect(cursor(lightbox.image)).toEqual(["cursor-zoom-in"]);
      expect(lightbox.image.getAttribute("data-zoom-click")).toBe("in");
      await clickAt(lightbox.surface, 500, 400);
      expect(lightbox.percent()).toBe("161%");
      expect(cursor(lightbox.image)).toEqual(["cursor-zoom-out"]);
      // The backdrop around the image keeps the ordinary arrow: a click there closes.
      expect(cursor(lightbox.surface)).toEqual([]);
      // The image takes the pointer so its own cursor shows.
      expect(lightbox.image.classList.contains("pointer-events-none")).toBe(false);
    } finally {
      await lightbox.cleanup();
    }
  });

  test("a large image zooms in on click, then pans with a grab cursor", async () => {
    const lightbox = await openLoneImage(2000, 1500);
    try {
      expect(lightbox.percent()).toBe("48%");
      expect(lightbox.image.classList.contains("cursor-zoom-in")).toBe(true);
      await clickAt(lightbox.surface, 500, 400);
      expect(lightbox.percent()).toBe("100%");
      expect(lightbox.image.classList.contains("cursor-grab")).toBe(true);
      expect(lightbox.open()).toBe(true);
    } finally {
      await lightbox.cleanup();
    }
  });

  test("empty space around the image area closes the viewer; its controls do not", async () => {
    const lightbox = await openLoneImage(600, 400);
    try {
      // The zoom controls' pill and its percentage act on zoom; they never close.
      await clickAt(document.querySelector("[data-zoom-percent]")!, 0, 0);
      await clickAt(document.querySelector("[data-zoom-controls]")!, 0, 0);
      expect(lightbox.open()).toBe(true);
      // A drag that starts on the image and is released in the gutter never closes.
      await act(async () => {
        lightbox.image.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "mouse" }),
        );
      });
      await act(async () => {
        document.querySelector("figure")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(lightbox.open()).toBe(true);
      // The figure's gutters and the gaps around the zoom controls are backdrop too.
      await clickAt(document.querySelector("figure")!, 0, 0);
      expect(lightbox.open()).toBe(false);
    } finally {
      await lightbox.cleanup();
    }
  });

  test("the caption is backdrop too, and Escape still closes", async () => {
    const first = await openLoneImage(600, 400);
    try {
      await clickAt(document.querySelector("figcaption")!, 0, 0);
      expect(first.open()).toBe(false);
    } finally {
      await first.cleanup();
    }
    const second = await openLoneImage(600, 400);
    try {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(second.open()).toBe(false);
    } finally {
      await second.cleanup();
    }
  });

  test("no part of the open viewer moves a desktop window, and its close button gives feedback", async () => {
    const lightbox = await openLoneImage(600, 400);
    try {
      // Electron keeps window-drag regions of the page underneath (the session
      // header) live through an overlay unless the overlay opts out.
      const dialog = document.querySelector('[role="dialog"]')!;
      const overlay = dialog.previousElementSibling!;
      for (const layer of [dialog, overlay]) {
        expect(layer.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
        expect(layer.classList.contains("[app-region:no-drag]")).toBe(true);
      }
      const close = document.querySelector('button[aria-label="Close"]')!;
      for (const feedback of ["hover:bg-white/15", "active:bg-white/25"]) {
        expect(close.classList.contains(feedback)).toBe(true);
      }
      await act(async () => {
        (close as HTMLButtonElement).click();
      });
      expect(lightbox.open()).toBe(false);
    } finally {
      await lightbox.cleanup();
    }
  });

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

  test("a page that settles after the provider unmounts releases its own source", async () => {
    const released: string[] = [];
    let settle: ((image: LightboxGalleryImage) => void) | null = null;
    let controller: ReturnType<typeof useLightboxOptional> = null;
    function Item({ name, deferred = false }: { name: string; deferred?: boolean }) {
      const host = useRef<HTMLDivElement>(null);
      useLightboxGalleryItem(host, {
        load: () =>
          deferred
            ? new Promise<LightboxGalleryImage>((resolve) => {
                settle = resolve;
              })
            : Promise.resolve({ src: `blob:${name}`, release: () => released.push(name) }),
      });
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
          <Item name="second" deferred />
        </div>
      </LightboxProvider>,
    );
    await act(async () => {
      controller?.open(
        "blob:clicked",
        "first",
        document.querySelector<HTMLElement>('[data-open="first"]'),
        "Image",
        undefined,
        undefined,
        () => released.push("clicked"),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("1 of 2");
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Next image"]')?.click();
    });
    expect(settle).not.toBeNull();

    await rendered.unmount();
    expect(released).toEqual(["clicked"]);
    await act(async () => {
      settle!({ src: "blob:late", release: () => released.push("late") });
      await Promise.resolve();
    });
    expect(released).toEqual(["clicked", "late"]);
  });

  test("arrow keys typed into a field never page the gallery", async () => {
    const loads: string[] = [];
    let controller: ReturnType<typeof useLightboxOptional> = null;
    function Item({ name }: { name: string }) {
      const host = useRef<HTMLDivElement>(null);
      useLightboxGalleryItem(host, {
        load: async () => {
          loads.push(name);
          return { src: `blob:${name}` };
        },
      });
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
          <Item name="second" />
        </div>
        <textarea data-field="" />
        <div contentEditable suppressContentEditableWarning data-editor="">
          <span data-editor-child="">draft</span>
        </div>
      </LightboxProvider>,
    );
    await act(async () => {
      controller?.open(
        "blob:first",
        "first",
        document.querySelector<HTMLElement>('[data-open="first"]'),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("1 of 2");

    for (const selector of ["[data-field]", "[data-editor-child]"]) {
      const field = document.querySelector<HTMLElement>(selector);
      const event = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        // A focused field, as when the user is typing in it.
        field?.focus();
        field?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        field?.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(loads).toEqual([]);
    expect(document.body.textContent).toContain("1 of 2");

    await act(async () => {
      document
        .querySelector('[data-open="first"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
    });
    expect(loads).toEqual(["second"]);
    expect(document.body.textContent).toContain("2 of 2");
    await rendered.unmount();
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

  test("chat images zoom in place: Cmd/Ctrl + plus zooms the image, not the window", async () => {
    let controller: ReturnType<typeof useLightboxOptional> = null;
    function Probe() {
      controller = useLightboxOptional();
      return <button type="button" data-open="only" />;
    }
    // The image area measures 1000 x 800 CSS pixels.
    const restore = measureZoomSurface();
    const rendered = await renderComponent(
      <LightboxProvider>
        <Probe />
      </LightboxProvider>,
    );
    try {
      await act(async () => {
        controller?.open(
          "blob:only",
          undefined,
          document.querySelector<HTMLElement>("[data-open]"),
        );
      });
      const image = document.querySelector<HTMLImageElement>("figure img")!;
      Object.defineProperty(image, "naturalWidth", { configurable: true, value: 2000 });
      Object.defineProperty(image, "naturalHeight", { configurable: true, value: 1500 });
      await act(async () => {
        image.dispatchEvent(new Event("load"));
      });
      const percent = () => document.querySelector("[data-zoom-percent]")?.textContent;
      expect(percent()).toBe("48%");
      const zoomIn = new KeyboardEvent("keydown", {
        key: "=",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        document.body.dispatchEvent(zoomIn);
      });
      expect(zoomIn.defaultPrevented).toBe(true);
      expect(percent()).toBe("50%");
      await act(async () => {
        document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click();
      });
      expect(percent()).toBe("75%");
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true }),
        );
      });
      expect(percent()).toBe("48%");

      await act(async () => {
        document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      });
      // Closed (its exit animation may still be running): the window zooms again.
      const outside = new KeyboardEvent("keydown", {
        key: "=",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(outside);
      expect(outside.defaultPrevented).toBe(false);
    } finally {
      restore();
      await rendered.unmount();
    }
  });
});
