import { describe, expect, test } from "bun:test";
import { defaultToolRegistry, type ToolCallItem } from "../src/timeline";
import { RollingActivity } from "../src/timeline/rolling-activity";
import { registerDom, renderComponent, flush } from "./render-hook";

registerDom();

const artifactId = "11111111-1111-4111-8111-111111111111";

function item(name: string, output: unknown): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tool-1",
    turnId: "turn-1",
    callId: "call-1",
    name,
    arguments: {},
    output,
    raw: undefined,
    status: "complete",
    occurredAt: new Date(0).toISOString(),
  };
}

const browserReceipt = {
  available: true,
  artifactId,
  kind: "browser_screenshot",
  contentType: "image/jpeg",
  originalBytes: 4,
  sha256: "a".repeat(64),
  retainedAt: "2026-08-05T00:00:00.000Z",
  dimensions: { width: 1, height: 1 },
  retention: { policy: "session_screenshot", expiresAt: "2026-09-04T00:00:00.000Z" },
  retrieval: {
    method: "GET",
    path: `/v1/workspaces/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/artifacts/${artifactId}/content`,
    acceptRanges: "bytes",
    maxRangeBytes: 1024 * 1024,
  },
};

describe("browser screenshot timeline", () => {
  test("rolling progress omits the image preview without claiming retrieval failed", async () => {
    const rendered = await renderComponent(
      <RollingActivity items={[item("interaction__browser_observe", browserReceipt)]} />,
    );
    await flush();
    expect(rendered.container.textContent).toContain("Observed browser");
    expect(rendered.container.textContent).not.toContain("retrieval is not configured");
    expect(rendered.container.textContent).not.toContain("retrieval failed");
    expect(rendered.container.querySelector(".og-reel-preview")).toBeNull();
    await rendered.unmount();
  });

  test("loads a session-authenticated browser screenshot without inline base64", async () => {
    const tool = item("interaction__browser_screenshot", browserReceipt);
    const Renderer = defaultToolRegistry.resolve(tool);
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const revoked: string[] = [];
    let loads = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:browser-screenshot",
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const rendered = await renderComponent(
        <Renderer
          item={tool}
          loadRetainedScreenshot={async () => {
            loads += 1;
            return Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
          }}
        />,
      );
      await flush();
      await flush();
      expect(loads).toBe(1);
      expect(rendered.container.textContent).toContain("Browser screenshot");
      expect(rendered.container.querySelector('img[src="blob:browser-screenshot"]')).not.toBeNull();
      expect(rendered.container.innerHTML).not.toContain("base64");
      await rendered.unmount();
      expect(revoked).toEqual(["blob:browser-screenshot"]);
    } finally {
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  test("browser observe image shares the renderer; an expired receipt stays unavailable", async () => {
    const observed = item("interaction__browser_observe", browserReceipt);
    const Renderer = defaultToolRegistry.resolve(observed);
    const original = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:browser-observe",
    });
    try {
      const rendered = await renderComponent(
        <Renderer item={observed} loadRetainedScreenshot={async () => Uint8Array.of(1, 2, 3)} />,
      );
      await flush();
      await flush();
      expect(rendered.container.textContent).toContain("Observed browser");
      await rendered.unmount();
    } finally {
      if (original) Object.defineProperty(URL, "createObjectURL", original);
      else Reflect.deleteProperty(URL, "createObjectURL");
    }

    const expired = item("browser_screenshot", {
      available: false,
      artifactId,
      reason: "expired",
    });
    let loads = 0;
    const ExpiredRenderer = defaultToolRegistry.resolve(expired);
    const rendered = await renderComponent(
      <ExpiredRenderer
        item={expired}
        loadRetainedScreenshot={async () => {
          loads += 1;
          return null;
        }}
      />,
    );
    expect(rendered.container.textContent).toContain("Browser screenshot · expired");
    expect(loads).toBe(0);
    await rendered.unmount();
  });
});
