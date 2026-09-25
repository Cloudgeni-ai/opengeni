// Resolvers for the optional Jev-backed `code_search` agent tool. A separate
// subpath keeps them out of browser bundles; only server code decides.

/**
 * The deployment half of the `code_search` decision. `split` gives the tool to
 * a fixed half of sessions (see `codeSearchSessionInExperiment`) so staging can
 * compare sessions with and without it.
 */
export type CodeSearchWorkspaceDefault = "off" | "on" | "split";
export type CodeSearchDeploymentPolicy = {
  available: boolean;
  workspaceDefault: CodeSearchWorkspaceDefault;
};

/**
 * What a workspace gets: the deployment decides first, so nothing enables the
 * tool where the deployment does not offer it. Otherwise an explicit workspace
 * choice wins, and an absent, null or malformed setting follows the deployment
 * default. Only this field is read, so an invalid sibling setting cannot turn
 * an explicit Off back into the deployment default.
 */
export function resolveWorkspaceCodeSearchMode(
  settings: unknown,
  deployment: CodeSearchDeploymentPolicy,
): CodeSearchWorkspaceDefault {
  if (!deployment.available) return "off";
  const explicit =
    typeof settings === "object" && settings !== null
      ? (settings as { codeSearchEnabled?: unknown }).codeSearchEnabled
      : undefined;
  if (explicit === true) return "on";
  if (explicit === false) return "off";
  return deployment.workspaceDefault;
}

/**
 * Fixed per-session half for the `split` experiment: 32-bit FNV-1a of the
 * session id, low bit 0 gets the tool. Deterministic and dependency-free, so
 * the arm never changes within a session (keeping the prompt prefix stable)
 * and analysis can recompute it from the id alone.
 */
export function codeSearchSessionInExperiment(sessionId: string): boolean {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 1) === 0;
}

/** Whether this session's turns get the Jev-backed `code_search` tool. */
export function resolveSessionCodeSearchEnabled(
  settings: unknown,
  deployment: CodeSearchDeploymentPolicy,
  sessionId: string,
): boolean {
  const mode = resolveWorkspaceCodeSearchMode(settings, deployment);
  return mode === "on" || (mode === "split" && codeSearchSessionInExperiment(sessionId));
}
