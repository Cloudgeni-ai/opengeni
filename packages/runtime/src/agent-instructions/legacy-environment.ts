import type { WorkspaceEnvironmentContext } from "./types";

/**
 * Workspace environment lines (metadata only) for the locked legacy CORE of
 * sessions without an agent configuration. The modular prompt has no
 * workspace-environment module: secrets live in vaults and are used by
 * reference, so nothing is exported into the shell.
 */
export function workspaceEnvironmentInstructions(
  environment: WorkspaceEnvironmentContext,
): string[] {
  const lines = [
    `A workspace environment named "${environment.name}" is attached to this session; its variables are exported in the sandbox shell environment.`,
  ];
  const variableNames = (environment.variableNames ?? []).filter((name) => name.length > 0);
  if (variableNames.length > 0) {
    lines.push(`Exported environment variables: ${[...variableNames].sort().join(", ")}.`);
  }
  const description = environment.description?.trim();
  if (description) {
    lines.push(`Environment notes from the operator: ${description}`);
  }
  return lines;
}
