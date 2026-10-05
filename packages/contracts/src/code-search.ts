// Resolvers for the optional Jev-backed `code_search` agent tool. A separate
// subpath keeps them out of browser bundles; only server code decides.

/**
 * Directories holding platform credential material that `code_search` never
 * searches or reads, as path segments matched at any depth: OpenGeni's
 * sandbox state (`.opengeni/`: Codemode bearer tokens, Git credential files
 * and bindings), the Azure CLI login cache (`.azure/`, from the sandbox's
 * service-principal login with HOME=/workspace) and a Connected Machine
 * agent's enrollment credentials (`.config/opengeni/`). The sandbox channel
 * enforces this list; `@opengeni/jev` keeps the same list for its engine, and
 * a worker test pins that the two agree.
 */
export const CODE_SEARCH_CREDENTIAL_DIRS: readonly (readonly string[])[] = [
  [".opengeni"],
  [".azure"],
  [".config", "opengeni"],
];

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
 * Which turns may use `code_search`, by who pays its judge. `all` (the default,
 * for self-hosted deployments) runs every turn's searches on the deployment's
 * judge key. `credits_only` runs a turn on the deployment's key only when the
 * turn's model is paid with OpenGeni credits; any other turn (a connected
 * subscription, a customer's own model key or a free model) uses the
 * workspace's or organization's own OpenRouter or Vercel AI Gateway
 * connection, or does not get the tool.
 */
export type CodeSearchFunding = "all" | "credits_only";

/** Hosts that serve the judge over the System One protocol. */
export type CodeSearchJudgeProvider = "typesafe" | "openrouter" | "vercel_gateway";

/** Customer connections that can run the judge on the customer's own key. */
export type CodeSearchCustomerJudgeProvider = "vercel_gateway" | "openrouter";

/** Fixed order in which a customer's connections are tried. */
export const CODE_SEARCH_CUSTOMER_JUDGE_PROVIDERS: readonly CodeSearchCustomerJudgeProvider[] = [
  "vercel_gateway",
  "openrouter",
];

/**
 * Who pays one turn's `code_search` judge, and with which key.
 * - `credits`: the deployment's key, for a turn paid with OpenGeni credits.
 * - `deployment`: the deployment's key, absorbed (funding `all` only).
 * - `external`: the workspace's or organization's own connection; the customer
 *   pays the provider and OpenGeni charges nothing.
 */
export type CodeSearchJudgeRoute =
  | {
      funding: "credits" | "deployment";
      keySource: "deployment";
      provider: CodeSearchJudgeProvider;
    }
  | {
      funding: "external";
      keySource: "workspace_connection" | "organization_connection";
      provider: CodeSearchCustomerJudgeProvider;
    };

/**
 * The judge route for one turn, or null when nobody may pay for it and the
 * turn must not get the tool. Every input is durable (the accepted turn's
 * frozen billing and the active connection rows), so every worker decides the
 * same way and transient provider health never changes the tool list. The tool
 * list changes only with the turn's billing, which changes only with its model
 * or provider (already a new upstream prompt cache), or when an administrator
 * connects or disconnects a provider connection, a deliberate switch like a
 * workspace Off.
 */
export function resolveCodeSearchJudgeRoute(input: {
  funding: CodeSearchFunding;
  /** The deployment judge's provider; the deployment policy already requires its key. */
  deploymentProvider: CodeSearchJudgeProvider;
  turnPaidWithOpenGeniCredits: boolean;
  /** Active connections that can pay for the judge. Read only for `credits_only` turns without credits. */
  customerConnections: () => {
    workspace: readonly CodeSearchCustomerJudgeProvider[];
    organization: readonly CodeSearchCustomerJudgeProvider[];
  };
}): CodeSearchJudgeRoute | null {
  if (input.turnPaidWithOpenGeniCredits) {
    return { funding: "credits", keySource: "deployment", provider: input.deploymentProvider };
  }
  if (input.funding === "all") {
    return { funding: "deployment", keySource: "deployment", provider: input.deploymentProvider };
  }
  const connections = input.customerConnections();
  for (const [keySource, providers] of [
    ["workspace_connection", connections.workspace],
    ["organization_connection", connections.organization],
  ] as const) {
    const provider = CODE_SEARCH_CUSTOMER_JUDGE_PROVIDERS.find((candidate) =>
      providers.includes(candidate),
    );
    if (provider) return { funding: "external", keySource, provider };
  }
  return null;
}

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
 * session that was created without it.
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
 * explicit workspace Off still pause it in running sessions, because they stop
 * repository content going to Jev; undoing that switch-off gives it back to
 * sessions frozen on. Each such change costs every affected session one
 * prompt-cache miss, which is accepted for a deliberate switch. Nothing else
 * changes the tool list of a running session.
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
