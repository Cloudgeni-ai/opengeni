import { normalizeMcpOutput, parseSandboxFileArtifactReceipt } from "@opengeni/sdk";
import { mcpToolLeaf } from "./tool-display-name";
import type { ActivityItem, TimelineGroup } from "./types";

/*
 * Pure presentation facts shared by the projection and the renderers. Kept
 * free of React so the session-only entry can inspect primary output without pulling
 * in rendering code.
 */

/** Shared browser preview allowlist; other published files remain downloads. */
export function isRetainedImageContentType(contentType: string): boolean {
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
  ].includes(contentType);
}

/** A published patch, applied locally with `git apply`. */
export function isPatchFilename(filename: string): boolean {
  return /\.(patch|diff)$/iu.test(filename.trim());
}

/**
 * Deliberately published images and patches are primary output, not
 * incidental screenshots or work files.
 */
export function activityPresentsImage(items: readonly ActivityItem[]): boolean {
  return items.some((item) => {
    if (item.kind !== "tool-call") return false;
    const name = mcpToolLeaf(item.name);
    if (name === "generate_image" || name === "image_generation_call") return true;
    if (item.status !== "complete" || name !== "sandbox_file_publish") return false;
    const output = normalizeMcpOutput(item.output);
    if (output.isError) return false;
    const receipt = parseSandboxFileArtifactReceipt(output.text);
    return (
      receipt !== null &&
      (isRetainedImageContentType(receipt.artifact.contentType) ||
        // A published patch is the deliverable when there's no pull request:
        // keep its card (with the apply command) visible like an image.
        isPatchFilename(receipt.filename))
    );
  });
}

export function timelineGroupContainsPresentedImage(group: TimelineGroup): boolean {
  switch (group.kind) {
    case "item":
      return false;
    case "activity":
      return (
        activityPresentsImage(group.items) ||
        (group.work?.details?.some(timelineGroupContainsPresentedImage) ?? false)
      );
    case "turn":
      return group.groups.some(timelineGroupContainsPresentedImage);
  }
}
