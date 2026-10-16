import { describe, expect, test } from "bun:test";
import type { RetainedArtifactMetadata } from "@opengeni/contracts";
import { defaultToolRegistry, type ToolCallItem } from "../src/timeline";
import { retainedToolResultImages } from "../src/timeline/parsers";
import { registerDom, renderComponent, flush } from "./render-hook";

registerDom();

function receipt(artifactId: string) {
  return {
    available: true,
    artifactId,
    kind: "computer_screenshot",
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
  } as const satisfies RetainedArtifactMetadata;
}

const first = receipt("11111111-1111-4111-8111-111111111111");
const second = receipt("44444444-4444-4444-8444-444444444444");
const text = { type: "input_text", text: '{"width":1280,"height":720}' };

function item(output: unknown): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tool-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "mcp_server__capture",
    arguments: {},
    output,
    raw: undefined,
    status: "complete",
    occurredAt: new Date(0).toISOString(),
  };
}

describe("images returned by any tool", () => {
  test("separates retained images from the rest of the result", () => {
    expect(retainedToolResultImages([text, first, second])).toEqual({
      images: [first, second],
      output: [text],
    });
    expect(retainedToolResultImages(JSON.stringify({ content: [text, first] }))).toEqual({
      images: [first],
      output: { content: [text] },
    });
    const plain = [text];
    expect(retainedToolResultImages(plain)).toEqual({ images: [], output: plain });
    // An image the platform could not keep is not shown as a loadable image.
    const missing = { available: false, artifactId: first.artifactId, reason: "expired" };
    expect(retainedToolResultImages([text, missing]).images).toEqual([]);
  });

  test("an integration tool's image is shown in the timeline", async () => {
    const tool = item([text, first, second]);
    const Renderer = defaultToolRegistry.resolve(tool);
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const loaded: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:tool-image",
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    try {
      const rendered = await renderComponent(
        <Renderer
          item={tool}
          loadRetainedScreenshot={async (artifact) => {
            loaded.push(artifact.artifactId);
            return Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
          }}
        />,
      );
      await flush();
      await flush();
      expect(loaded[0]).toBe(first.artifactId);
      expect(rendered.container.querySelector('img[src="blob:tool-image"]')).not.toBeNull();
      expect(rendered.container.textContent).toContain("Capture");
      expect(rendered.container.innerHTML).not.toContain(first.retrieval.path);
      await rendered.unmount();
    } finally {
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
