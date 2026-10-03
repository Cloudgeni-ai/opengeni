import { z } from "zod";

import { RetainedArtifactReferenceSchema } from "./retained-output";

/**
 * Channel-A currently returns one bounded binary-safe read. Keep publication
 * below that ceiling so an extra sentinel byte can distinguish an exact file
 * from a truncated prefix.
 */
export const SANDBOX_FILE_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024 - 1;

export const PublishSandboxFileArtifactRequest = z
  .object({
    path: z.string().min(1).max(4_096),
  })
  .strict();
export type PublishSandboxFileArtifactRequest = z.infer<typeof PublishSandboxFileArtifactRequest>;

/**
 * Closed model/UI receipt for one exact sandbox-file publication. Storage
 * locators and signed URLs never cross this boundary.
 */
export const SandboxFileArtifactReceipt = z
  .object({
    type: z.literal("sandbox_file"),
    sandboxPath: z.string().min(1).max(4_096),
    filename: z.string().min(1).max(1_024),
    artifact: RetainedArtifactReferenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const pathSegments = value.sandboxPath.split("/");
    // This is a receipt, not read authority. The publisher confines the path
    // against its resolved provider root; receipts preserve that native path.
    const unc = value.sandboxPath.startsWith("//");
    const absolute = unc
      ? /^\/\/[^/]+\/[^/]+\/.+/u.test(value.sandboxPath) && !value.sandboxPath.startsWith("//?/")
      : value.sandboxPath.startsWith("/") || /^[A-Z]:\//u.test(value.sandboxPath);
    if (
      !absolute ||
      /[\\\u0000-\u001f\u007f]/u.test(value.sandboxPath) ||
      pathSegments.some(
        (segment, index) =>
          index >= (unc ? 2 : 1) && (!segment || segment === "." || segment === ".."),
      ) ||
      pathSegments.at(-1) !== value.filename
    ) {
      context.addIssue({
        code: "custom",
        path: ["sandboxPath"],
        message:
          "sandbox path must canonically identify the published filename at an absolute host path",
      });
    }
    if (value.artifact.kind !== "file" || value.artifact.retention.policy !== "workspace_file") {
      context.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "sandbox files require a permanent workspace-file artifact",
      });
    }
    if (
      value.artifact.originalBytes < 1 ||
      value.artifact.originalBytes > SANDBOX_FILE_ARTIFACT_MAX_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "originalBytes"],
        message: "sandbox file size is outside the publication byte limit",
      });
    }
  });
export type SandboxFileArtifactReceipt = z.infer<typeof SandboxFileArtifactReceipt>;
