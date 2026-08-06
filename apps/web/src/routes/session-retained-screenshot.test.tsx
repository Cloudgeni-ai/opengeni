import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { defaultToolRegistry, type ToolCallItem } from "../../../../packages/react/src/timeline";

import { createSessionRetainedScreenshotLoader } from "@/lib/retained-screenshot-loader";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  GlobalRegistrator.unregister();
});

const artifact: RetainedArtifactReference = {
  available: true,
  artifactId: "11111111-1111-4111-8111-111111111111",
  kind: "computer_screenshot",
  contentType: "image/png",
  originalBytes: 4,
  sha256: "a".repeat(64),
  retainedAt: "2026-08-05T00:00:00.000Z",
  dimensions: { width: 1, height: 1 },
  retention: {
    policy: "session_screenshot",
    expiresAt: "2026-09-04T00:00:00.000Z",
  },
  retrieval: {
    method: "GET",
    path: "/v1/workspaces/workspace-a/sessions/session-a/artifacts/receipt/content",
    acceptRanges: "bytes",
    maxRangeBytes: 1024 * 1024,
  },
};

function screenshotItem(output: unknown): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tool-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "computer_screenshot",
    arguments: {},
    output,
    raw: { type: "computer_call", action: { type: "screenshot" } },
    status: "complete",
    occurredAt: "2026-08-05T00:00:00.000Z",
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("production session retained screenshot loader", () => {
  test("uses the authenticated session downloader and reaches the rendered image state", async () => {
    let settle!: (download: { metadata: RetainedArtifactReference; bytes: Uint8Array }) => void;
    const pending = new Promise<{
      metadata: RetainedArtifactReference;
      bytes: Uint8Array;
    }>((resolve) => {
      settle = resolve;
    });
    const calls: Array<{
      workspaceId: string;
      sessionId: string;
      artifactId: string;
      signal: AbortSignal | undefined;
    }> = [];
    const client = {
      downloadRetainedScreenshot: async (
        workspaceId: string,
        sessionId: string,
        artifactId: string,
        options: { signal?: AbortSignal } = {},
      ) => {
        calls.push({ workspaceId, sessionId, artifactId, signal: options.signal });
        return await pending;
      },
    };
    const loader = createSessionRetainedScreenshotLoader(client, "workspace-a", "session-a");
    const item = screenshotItem(artifact);
    const Renderer = defaultToolRegistry.resolve(item);
    const container = document.createElement("div");
    const root = createRoot(container);
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:web-retained-screenshot",
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    try {
      await act(async () => root.render(<Renderer item={item} loadRetainedScreenshot={loader} />));
      expect(calls).toHaveLength(1);
      const trigger = container.querySelector('[role="button"]') as HTMLElement | null;
      await act(async () => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(container.textContent).toContain("Loading the retained screenshot");

      settle({ metadata: artifact, bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) });
      await flush();

      expect(calls[0]).toMatchObject({
        workspaceId: "workspace-a",
        sessionId: "session-a",
        artifactId: artifact.artifactId,
      });
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(container.querySelector('img[src="blob:web-retained-screenshot"]')).not.toBeNull();
      expect(container.textContent).not.toContain("objectKey");
      expect(container.textContent).not.toContain("base64");

      await act(async () => root.unmount());
      expect(calls[0]!.signal?.aborted).toBe(true);
    } finally {
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  test("recovers after the authenticated client changes without exposing the prior error", async () => {
    const firstLoader = createSessionRetainedScreenshotLoader(
      {
        downloadRetainedScreenshot: async () => {
          throw new Error("s3://private-bucket/object-key data:image/png;base64,secret");
        },
      },
      "workspace-a",
      "session-a",
    );
    const secondLoader = createSessionRetainedScreenshotLoader(
      {
        downloadRetainedScreenshot: async () => ({
          metadata: artifact,
          bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
        }),
      },
      "workspace-a",
      "session-a",
    );
    const item = screenshotItem(artifact);
    const Renderer = defaultToolRegistry.resolve(item);
    const container = document.createElement("div");
    const root = createRoot(container);
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:web-retained-reconnected",
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    try {
      await act(async () =>
        root.render(<Renderer item={item} loadRetainedScreenshot={firstLoader} />),
      );
      await flush();
      const trigger = container.querySelector('[role="button"]') as HTMLElement | null;
      await act(async () => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(container.textContent?.toLowerCase()).toContain("screenshot retrieval failed");
      expect(container.textContent).not.toContain("private-bucket");
      expect(container.textContent).not.toContain("base64,secret");

      await act(async () =>
        root.render(<Renderer item={item} loadRetainedScreenshot={secondLoader} />),
      );
      await flush();
      expect(container.querySelector('img[src="blob:web-retained-reconnected"]')).not.toBeNull();
      await act(async () => root.unmount());
    } finally {
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  test("keeps an unavailable receipt truthful and does not invoke retrieval", async () => {
    let calls = 0;
    const loader = createSessionRetainedScreenshotLoader(
      {
        downloadRetainedScreenshot: async () => {
          calls += 1;
          return { metadata: artifact, bytes: Uint8Array.of(1) };
        },
      },
      "workspace-a",
      "session-a",
    );
    const item = screenshotItem({
      available: false,
      artifactId: artifact.artifactId,
      reason: "expired",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Renderer item={item} loadRetainedScreenshot={loader} />));
    await flush();
    expect(calls).toBe(0);
    expect(container.textContent?.toLowerCase()).toContain("screenshot · expired");
    await act(async () => root.unmount());
  });
});
