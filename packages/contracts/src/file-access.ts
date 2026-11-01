import { defineSchema } from "./define-schema";
import { z } from "zod";

import { WorkspaceArtifactVisibility } from "./artifacts";

/**
 * Who can open a file, in the same two words as a Site or a chat: only its
 * owner ("private", shown as Only me) or everyone in the workspace.
 * `whoCanOpen` is one plain sentence for the agent that made or shared the
 * file, so it never sends a private link to someone who cannot open it.
 */
export const FileAccess = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      visibility: WorkspaceArtifactVisibility,
      whoCanOpen: z.string().min(1).max(512),
    })
    .strict(),
);
export type FileAccess = z.infer<typeof FileAccess>;

/** The owner's change of who can open one file. */
export const UpdateFileVisibilityRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ visibility: WorkspaceArtifactVisibility }).strict(),
);
export type UpdateFileVisibilityRequest = z.infer<typeof UpdateFileVisibilityRequest>;

/**
 * The owner's change of where their Only me file works: the other workspaces
 * of the organization they belong to, besides the one that stores it and their
 * Personal workspace, or null for every workspace. It stays Only me in each.
 */
export const UpdateFileReachRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ reachWorkspaceIds: z.array(z.string().uuid()).max(200).nullable() }).strict(),
);
export type UpdateFileReachRequest = z.infer<typeof UpdateFileReachRequest>;
