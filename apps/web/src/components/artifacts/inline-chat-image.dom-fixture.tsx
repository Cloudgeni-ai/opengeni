import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RetainedArtifactReference } from "@opengeni/sdk";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const artifact: RetainedArtifactReference = {
  available: true,
  artifactId: "image",
  kind: "file",
  contentType: "image/png",
  originalBytes: 1,
  sha256: "a".repeat(64),
  retainedAt: "2026-09-01T00:00:00Z",
  retention: { policy: "workspace_file", expiresAt: null },
  retrieval: {
    method: "GET",
    path: "/retained/image",
    acceptRanges: "bytes",
    maxRangeBytes: 1048576,
  },
};
let metadata = deferred<RetainedArtifactReference>();
let bytes = deferred<{ artifact: RetainedArtifactReference; bytes: Uint8Array }>();
let metadataCalls = 0;
let byteCalls = 0;
const open = mock(() => {});
mock.module("@/context", () => ({
  useAppContext: () => ({
    accessKeyVersion: 1,
    client,
  }),
}));
const client = {
  getRetainedArtifact: () => {
    metadataCalls++;
    return metadata.promise;
  },
  downloadRetainedArtifact: () => {
    byteCalls++;
    return bytes.promise;
  },
};
mock.module("@opengeni/react", () => ({ useLightboxOptional: () => ({ open }) }));
mock.module("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#artifact" className={className}>
      {children}
    </a>
  ),
}));
const { InlineChatImage } = await import("./inline-chat-image");

let notify: IntersectionObserverCallback | undefined;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  metadata = deferred();
  bytes = deferred();
  metadataCalls = 0;
  byteCalls = 0;
  notify = undefined;
  open.mockClear();
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

async function render(thumbnail = false, showArtifactLink = false, viewer = false) {
  await act(async () =>
    root.render(
      <InlineChatImage
        workspaceId="workspace"
        artifactId="image"
        alt="Diagram"
        thumbnail={thumbnail}
        showArtifactLink={showArtifactLink}
        viewer={viewer}
      />,
    ),
  );
}
async function enterViewport() {
  expect(notify).toBeDefined();
  await act(async () =>
    notify!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
  );
}
function slot() {
  const element = container.querySelector<HTMLDivElement>("div.flex.flex-col");
  expect(element).not.toBeNull();
  expect(element!.style.height).toBe("360px");
  expect(element!.className).toContain("overflow-hidden");
  return element!;
}

for (const dimensions of [
  undefined,
  { width: 12000, height: 8000 },
  { width: 200, height: 1600 },
]) {
  test(`metadata and bytes are deferred with a stable ready slot: ${JSON.stringify(dimensions)}`, async () => {
    await render();
    expect(metadataCalls).toBe(0);
    expect(byteCalls).toBe(0);
    expect(container.querySelector("img")).toBeNull();
    await enterViewport();
    const reserved = slot();
    expect(metadataCalls).toBe(1);
    expect(byteCalls).toBe(0);
    await act(async () => metadata.resolve({ ...artifact, dimensions }));
    expect(byteCalls).toBe(1);
    expect(slot()).toBe(reserved);
    expect(container.textContent).toContain("Loading image");
    await act(async () => bytes.resolve({ artifact, bytes: new Uint8Array([0]) }));
    expect(slot()).toBe(reserved);
    const image = container.querySelector("img")!;
    expect(image.alt).toBe("Diagram");
    expect(image.className).toContain("h-full w-full");
    expect(image.className).toContain("object-contain");
    expect(image.getAttribute("width")).toBe(dimensions ? String(dimensions.width) : null);
    const expand = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand Diagram"]',
    )!;
    await act(async () => expand.click());
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(slot()).toBe(reserved);
    expect(container.textContent).toContain("Diagram unavailable");
    expect(container.textContent).toContain("Retry");
  });
}

for (const failure of ["metadata", "bytes"] as const) {
  test(`${failure} failure and retry preserve reserved geometry`, async () => {
    await render();
    await enterViewport();
    const reserved = slot();
    if (failure === "bytes") await act(async () => metadata.resolve(artifact));
    await act(async () =>
      (failure === "metadata" ? metadata : bytes).reject(new Error("Unavailable")),
    );
    expect(slot()).toBe(reserved);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("unavailable");
    metadata = deferred();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(metadataCalls).toBe(2);
    expect(slot()).toBe(reserved);
    expect(container.textContent).toContain("Loading image");
  });
}

test("thumbnails remain eager, container-sized, and non-interactive", async () => {
  await render(true, true);
  expect(notify).toBeUndefined();
  expect(metadataCalls).toBe(1);
  expect(container.querySelector('[style*="360"]')).toBeNull();
  await act(async () => metadata.resolve(artifact));
  await act(async () => bytes.resolve({ artifact, bytes: new Uint8Array([0]) }));
  const image = container.querySelector("img")!;
  expect(image.className).toBe("h-full w-full object-contain");
  expect(container.querySelector("button, a")).toBeNull();
  await act(async () => image.dispatchEvent(new Event("error")));
  expect(container.textContent).toContain("unavailable");
  expect(container.querySelector("button, a")).toBeNull();
});

test("artifact viewer loads without a chat slot and fits the page and viewport", async () => {
  await render(false, false, true);
  expect(notify).toBeUndefined();
  expect(metadataCalls).toBe(1);
  expect(container.querySelector('[style*="360"]')).toBeNull();
  await act(async () => metadata.resolve(artifact));
  await act(async () => bytes.resolve({ artifact, bytes: new Uint8Array([0]) }));
  const image = container.querySelector("img")!;
  expect(image.className).toContain("h-auto");
  expect(image.className).toContain("max-h-[calc(100dvh-12rem)]");
  expect(image.className).toContain("w-full");
  expect(image.className).toContain("object-contain");
  const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Diagram"]')!;
  expect(expand.className).not.toContain("h-full");
  await act(async () => expand.click());
  expect(open).toHaveBeenCalledTimes(1);
});

test("the optional artifact link stays inside the original reserved slot", async () => {
  await render(false, true);
  await enterViewport();
  const reserved = slot();
  await act(async () => metadata.resolve(artifact));
  const link = container.querySelector("a")!;
  expect(link.textContent).toBe("Open in Artifacts");
  expect(reserved.contains(link)).toBe(true);
  expect(link.className).toContain("shrink-0");
  await act(async () => bytes.resolve({ artifact, bytes: new Uint8Array([0]) }));
  expect(slot()).toBe(reserved);
  expect(reserved.querySelector("img")).not.toBeNull();
});
