import { XaiProviderAccountAuthoritySnapshotV1 } from "./xai-provider-account-authority";
import type { z } from "zod";

/** Same opaque pool selection shape; Claude's live authority is revalidated separately. */
export const ClaudeProviderAccountAuthoritySnapshotV1 = XaiProviderAccountAuthoritySnapshotV1;
export type ClaudeProviderAccountAuthoritySnapshotV1 = z.infer<
  typeof ClaudeProviderAccountAuthoritySnapshotV1
>;
export const WORKSPACE_CLAUDE_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1 = {
  version: 1,
  scope: "workspace",
} as const satisfies ClaudeProviderAccountAuthoritySnapshotV1;
