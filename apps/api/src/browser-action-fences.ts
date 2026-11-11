import type { BrowserActionRequest, BrowserTargetState } from "@opengeni/contracts";

export type BrowserActionFences = {
  expectedTargetGeneration: string;
  expectedDocumentGeneration: string | null;
  expectedFrameId: string | null;
};

/**
 * Complete a browser action's causal fences. Supplied fences are kept exactly;
 * any omitted one is the target's current value, read from the live controller
 * only when needed. This keeps the "act on the current document" request to
 * one API round trip instead of a separate target-state request before it.
 */
export async function resolveBrowserActionFences(
  request: Pick<
    BrowserActionRequest,
    "expectedTargetGeneration" | "expectedDocumentGeneration" | "expectedFrameId"
  >,
  readTargetState: () => Promise<
    Pick<BrowserTargetState, "targetGeneration" | "documentGeneration" | "frameId">
  >,
): Promise<BrowserActionFences> {
  if (
    request.expectedTargetGeneration !== undefined &&
    request.expectedDocumentGeneration !== undefined &&
    request.expectedFrameId !== undefined
  ) {
    return {
      expectedTargetGeneration: request.expectedTargetGeneration,
      expectedDocumentGeneration: request.expectedDocumentGeneration,
      expectedFrameId: request.expectedFrameId,
    };
  }
  const current = await readTargetState();
  return {
    expectedTargetGeneration: request.expectedTargetGeneration ?? current.targetGeneration,
    expectedDocumentGeneration:
      request.expectedDocumentGeneration === undefined
        ? current.documentGeneration
        : request.expectedDocumentGeneration,
    expectedFrameId:
      request.expectedFrameId === undefined ? current.frameId : request.expectedFrameId,
  };
}
