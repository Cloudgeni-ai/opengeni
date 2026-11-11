/**
 * The workspace the pane opens in: the one picked in this pane before, else
 * the person's own default (the workspace the web app also lands in when it
 * has nothing remembered), else the first they can open. Never another
 * person's workspace just because it sorts first.
 */
export function landingWorkspaceId(input: {
  workspaceIds: readonly string[];
  remembered: string | null;
  defaultWorkspaceId: string | null | undefined;
}): string | null {
  const { workspaceIds, remembered, defaultWorkspaceId } = input;
  if (remembered && workspaceIds.includes(remembered)) return remembered;
  if (defaultWorkspaceId && workspaceIds.includes(defaultWorkspaceId)) return defaultWorkspaceId;
  return workspaceIds[0] ?? null;
}
