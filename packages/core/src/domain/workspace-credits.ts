import { getWorkspaceModelPolicy, type Database } from "@opengeni/db";

/**
 * True when the workspace turned Opengeni credits off. Every meter that would
 * spend credits (credit-billed models, voice, web search, knowledge
 * embeddings) honors this one switch.
 */
export async function workspaceCreditsDisabled(
  db: Database,
  workspaceId: string,
): Promise<boolean> {
  return (await getWorkspaceModelPolicy(db, workspaceId))?.allowCreditModels === false;
}
