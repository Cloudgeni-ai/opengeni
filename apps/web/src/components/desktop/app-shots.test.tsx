import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AppShotCapture } from "@opengeni/contracts";
import type { UseFileAttachmentsResult } from "@opengeni/react";
import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// A desktop app that offers app-shots, before the modules read the bridge.
(globalThis as Record<string, unknown>).opengeniDesktop = {
  version: 1,
  platform: "macos",
  capabilities: ["appShots"],
};

const {
  appShotCaptureFrom,
  appShotFileName,
  browserProfilesOnComputer,
  deliverAppShot,
  resetAppShotTargetsForTest,
  useAppShotTarget,
} = await import("@opengeni/react/app/components/desktop/app-shots");
const { acceleratorFromKey, shortcutLabel } = await import("./app-shots-settings");

afterAll(() => {
  delete (globalThis as Record<string, unknown>).opengeniDesktop;
  GlobalRegistrator.unregister();
});

const shot = {
  image: new Uint8Array([1, 2, 3]),
  mimeType: "image/png" as const,
  app: "Safari",
  bundleId: "com.apple.Safari",
  title: "Example Domain",
  capturedAt: "2026-10-20T09:15:00.000Z",
  platform: "macos" as const,
  text: "Example Domain\nMore information...",
  window: { processId: 812, windowId: 4211 },
};

describe("app-shot capture", () => {
  test("keeps what the window showed and the computer agents know", () => {
    expect(appShotCaptureFrom(shot, { name: "Studio Mac", sandboxId: "sbx-1" })).toEqual({
      app: "Safari",
      bundleId: "com.apple.Safari",
      title: "Example Domain",
      capturedAt: "2026-10-20T09:15:00.000Z",
      platform: "macos",
      text: "Example Domain\nMore information...",
      window: { processId: 812, windowId: 4211 },
      computer: { name: "Studio Mac", sandboxId: "sbx-1" },
    });
  });

  test("cuts text over the limit and drops empty text", () => {
    const long = appShotCaptureFrom({ ...shot, text: "x".repeat(40_000) }, null);
    expect(long.text).toHaveLength(32_000);
    expect(long.textTruncated).toBe(true);
    const blank = appShotCaptureFrom({ ...shot, text: "  \n " }, null);
    expect(blank.text).toBeUndefined();
    expect(blank.computer).toBeUndefined();
  });

  test("names the file after the window", () => {
    expect(appShotFileName(shot)).toBe("Safari - Example Domain.png");
    expect(appShotFileName({ app: "Terminal", title: "a/b: c" })).toBe("Terminal - a b c.png");
    expect(appShotFileName({ app: " ", title: "" })).toBe("App-shot.png");
  });

  const chrome = {
    ...shot,
    app: "Google Chrome",
    bundleId: "com.google.Chrome",
    browser: { url: "https://example.com/", chromium: true },
  };
  const work = { deviceId: "0b6f2a54-8c1d-4e3a-9f7b-2d5c6e8a1b40", name: "Work" };

  test("keeps a browser page's address and the connected profiles it can continue in", () => {
    const linked = appShotCaptureFrom(chrome, { name: "Studio Mac", sandboxId: "sbx-1" }, [work]);
    expect(linked.browser).toEqual({ url: "https://example.com/", profiles: [work] });
    // Without a connected computer, or outside a Chromium browser: the page only.
    expect(appShotCaptureFrom(chrome, null, [work]).browser).toEqual({
      url: "https://example.com/",
    });
    const safari = { ...shot, browser: { url: "https://example.com/", chromium: false } };
    expect(appShotCaptureFrom(safari, { name: "Studio Mac" }, [work]).browser).toEqual({
      url: "https://example.com/",
    });
    expect(appShotCaptureFrom(shot, { name: "Studio Mac" }, [work]).browser).toBeUndefined();
  });

  test("finds the browser profiles connected from this computer, in a stable order", () => {
    const device = (id: string, overrides: Record<string, unknown>) =>
      ({
        id,
        enrollmentId: "enr-this",
        name: "Chrome on Studio Mac",
        profileLabel: null,
        browserName: "Chrome",
        state: "connected",
        ...overrides,
      }) as unknown as Parameters<typeof browserProfilesOnComputer>[0][number];
    const devices = [
      device("d-3", { profileLabel: "Work" }),
      device("d-1", { profileLabel: "Personal" }),
      device("d-2", { enrollmentId: "enr-other", profileLabel: "Elsewhere" }),
      device("d-4", { state: "disconnected", profileLabel: "Closed" }),
      device("d-5", {}),
    ];
    expect(browserProfilesOnComputer(devices, "enr-this")).toEqual([
      { deviceId: "d-5", name: "Chrome on Studio Mac" },
      { deviceId: "d-1", name: "Personal" },
      { deviceId: "d-3", name: "Work" },
    ]);
    expect(browserProfilesOnComputer(devices, "enr-none")).toEqual([]);
  });
});

describe("app-shot composer targets", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    resetAppShotTargetsForTest();
    document.body.innerHTML = "";
  });

  function attachmentsRecorder(received: string[]): UseFileAttachmentsResult {
    return {
      addAppShot: (image: File, capture: AppShotCapture) =>
        received.push(`${image.name}|${capture.app}`),
    } as unknown as UseFileAttachmentsResult;
  }

  function Composer({ id, received }: { id: string; received: string[] }) {
    const region = useRef<HTMLDivElement>(null);
    useAppShotTarget(attachmentsRecorder(received), region);
    return (
      <div ref={region} data-composer={id}>
        <textarea aria-label={id} />
      </div>
    );
  }

  const delivery = {
    image: new File([new Uint8Array([1])], "Safari - Example Domain.png", { type: "image/png" }),
    capture: appShotCaptureFrom(shot, null),
  };

  test("a capture without a composer waits for the next one to mount", async () => {
    const events: string[] = [];
    function RemountedComposer() {
      const region = useRef<HTMLDivElement>(null);
      // Stands in for the attachment queue, which fences uploads on unmount.
      useEffect(() => () => void events.push("unmount"), []);
      useAppShotTarget(
        {
          addAppShot: (image: File, capture: AppShotCapture) =>
            events.push(`attach ${image.name}|${capture.app}`),
        } as unknown as UseFileAttachmentsResult,
        region,
      );
      return (
        <div ref={region}>
          <textarea aria-label="composer" />
        </div>
      );
    }
    expect(deliverAppShot(delivery)).toBe(false);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // Development mounts twice: the capture attaches once, to the mount that stays.
    act(() =>
      root!.render(
        <StrictMode>
          <RemountedComposer />
        </StrictMode>,
      ),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(events).toEqual(["unmount", "attach Safari - Example Domain.png|Safari"]);
  });

  test("the composer focused last receives the capture", () => {
    const first: string[] = [];
    const second: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <>
          <Composer id="first" received={first} />
          <Composer id="second" received={second} />
        </>,
      ),
    );
    expect(deliverAppShot(delivery)).toBe(true);
    expect(second).toHaveLength(1);
    act(() => {
      container.querySelector<HTMLTextAreaElement>('[aria-label="first"]')!.focus();
    });
    deliverAppShot(delivery);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

describe("app-shot shortcut settings", () => {
  test("labels shortcuts the way each system writes them", () => {
    expect(shortcutLabel({ kind: "modifierPair", modifier: "command" }, "macos")).toBe(
      "Both ⌘ Command keys",
    );
    expect(
      shortcutLabel({ kind: "accelerator", accelerator: "CommandOrControl+Shift+2" }, "macos"),
    ).toBe("⌘⇧2");
    expect(
      shortcutLabel({ kind: "accelerator", accelerator: "CommandOrControl+Shift+2" }, "windows"),
    ).toBe("Ctrl+Shift+2");
  });

  test("turns a pressed combination into an accelerator", () => {
    const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
      code,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(acceleratorFromKey(key("Digit2", { metaKey: true, shiftKey: true }), "macos")).toBe(
      "Command+Shift+2",
    );
    expect(acceleratorFromKey(key("KeyS", { ctrlKey: true, altKey: true }), "linux")).toBe(
      "Control+Alt+S",
    );
    // Modifiers alone, Shift alone, or no modifier make no shortcut.
    expect(acceleratorFromKey(key("ShiftLeft", { shiftKey: true }), "macos")).toBeNull();
    expect(acceleratorFromKey(key("KeyA", { shiftKey: true }), "macos")).toBeNull();
    expect(acceleratorFromKey(key("KeyA"), "macos")).toBeNull();
  });
});
