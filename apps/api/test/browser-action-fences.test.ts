import { describe, expect, test } from "bun:test";
import { resolveBrowserActionFences } from "../src/browser-action-fences";

const current = {
  targetGeneration: "target-current",
  documentGeneration: "document-current",
  frameId: "frame-current",
};

describe("resolveBrowserActionFences", () => {
  test("keeps complete caller fences without reading the target", async () => {
    let reads = 0;
    const fences = await resolveBrowserActionFences(
      {
        expectedTargetGeneration: "target-1",
        expectedDocumentGeneration: null,
        expectedFrameId: null,
      },
      async () => {
        reads += 1;
        return current;
      },
    );
    expect(fences).toEqual({
      expectedTargetGeneration: "target-1",
      expectedDocumentGeneration: null,
      expectedFrameId: null,
    });
    expect(reads).toBe(0);
  });

  test("fills omitted fences from one current target read", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return current;
    };
    expect(await resolveBrowserActionFences({}, read)).toEqual({
      expectedTargetGeneration: "target-current",
      expectedDocumentGeneration: "document-current",
      expectedFrameId: "frame-current",
    });
    expect(
      await resolveBrowserActionFences(
        { expectedTargetGeneration: "target-1", expectedDocumentGeneration: null },
        read,
      ),
    ).toEqual({
      expectedTargetGeneration: "target-1",
      expectedDocumentGeneration: null,
      expectedFrameId: "frame-current",
    });
    expect(reads).toBe(2);
  });
});
