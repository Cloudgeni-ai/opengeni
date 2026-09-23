import { getSandboxRecoveryDiscontinuity, type Database } from "@opengeni/db";

/** Opt-in belongs to this warning-aware worker implementation, not the DB
 * client, role defaults or deployment configuration. Claim stamps it locally. */
export const FILESYSTEM_DISCONTINUITY_PROTOCOL = 1 as const;

export async function recoveryAwareSessionInstructions(
  db: Database,
  workspaceId: string,
  session: { id: string; instructions?: string | null },
): Promise<string> {
  const filesystemDiscontinuity = await getSandboxRecoveryDiscontinuity(
    db,
    workspaceId,
    session.id,
  );
  return [session.instructions, filesystemDiscontinuity].filter(Boolean).join("\n\n");
}
