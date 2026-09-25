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
  const explicit = explicitWorkspaceCodeSearchSetting(settings);
  if (explicit === true) return "on";
  if (explicit === false) return "off";
  return deployment.workspaceDefault;
}

function explicitWorkspaceCodeSearchSetting(settings: unknown): boolean | undefined {
  const explicit =
    typeof settings === "object" && settings !== null
      ? (settings as { codeSearchEnabled?: unknown }).codeSearchEnabled
      : undefined;
  return typeof explicit === "boolean" ? explicit : undefined;
}

/**
 * Fixed per-session half for the `split` experiment: 32-bit FNV-1a of the
 * session id, low bit 0 gets the tool. Deterministic and dependency-free, so
 * a root session's arm can be recomputed from its id. Child sessions inherit
 * their parent's decision instead.
 */
export function codeSearchSessionInExperiment(sessionId: string): boolean {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 1) === 0;
}

/**
 * The decision frozen on a new root session when it is created. Later changes
 * to the workspace setting or the deployment mode never turn the tool on for a
 * session that already exists.
 */
export function resolveSessionCodeSearchEnabled(
  settings: unknown,
  deployment: CodeSearchDeploymentPolicy,
  sessionId: string,
): boolean {
  const mode = resolveWorkspaceCodeSearchMode(settings, deployment);
  return mode === "on" || (mode === "split" && codeSearchSessionInExperiment(sessionId));
}

/**
 * Whether a turn of this session gets `code_search`. Only a session frozen on
 * at creation can have it. The deployment (mode off or no usable key) and an
 * explicit workspace Off still switch it off for running sessions, because
 * they stop repository content going to Jev. That costs each running session
 * one prompt-cache miss, which is accepted for a deliberate switch-off. Nothing
 * else changes the tool list of a running session.
 */
export function codeSearchEnabledForTurn(
  frozen: boolean | null | undefined,
  settings: unknown,
  deployment: CodeSearchDeploymentPolicy,
): boolean {
  return (
    frozen === true &&
    deployment.available &&
    explicitWorkspaceCodeSearchSetting(settings) !== false
  );
}
