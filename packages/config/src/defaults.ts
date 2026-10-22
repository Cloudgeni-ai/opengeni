// Immutable configuration defaults, independent of settings validation and provider adapters.
export const DEFAULT_OPENROUTER_MODEL_ID =
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free" as const;

export const DEFAULT_MODEL_COST_POLICY_JSON = JSON.stringify({
  [DEFAULT_OPENROUTER_MODEL_ID]: "free",
});

/** Default pacing between consecutive no-input goal continuations. */
export const DEFAULT_GOAL_IDLE_BACKOFF_MS: readonly number[] = [3_000, 30_000, 120_000, 300_000];

export const DEFAULT_GOAL_IDLE_BACKOFF_MAX_MS = 600_000;

/**
 * Turn-worker graceful shutdown. A draining turn worker lets in-flight turns
 * finish naturally for the grace, then cancels the rest with WORKER_SHUTDOWN
 * (recoverable checkpoint), and the Temporal SDK force-stops at the force time.
 * With the standalone process exit ten seconds after the force time, these fit
 * inside the 120-second Kubernetes termination grace used by the Helm chart.
 */
export const DEFAULT_TURN_WORKER_SHUTDOWN_GRACE_MS = 90_000;
export const DEFAULT_TURN_WORKER_SHUTDOWN_FORCE_MS = 105_000;

/**
 * Placeholder token inside an agent-instructions persona template. The runtime
 * substitutes the non-bypassable CORE (goal-loop ownership + the dynamic
 * workspace-environment block) at this marker. A template that omits the
 * marker still gets the CORE appended after it (a non-bypassable fail-safe),
 * so a white-labelled persona can never drop the goal-loop contract or the
 * environment metadata the agent depends on.
 */
export const AGENT_INSTRUCTIONS_CORE_PLACEHOLDER = "{{core}}";

/**
 * Default per-workspace agent persona template. This is the BRAND + tool-usage
 * opinion (the white-labellable surface): the general-assistant identity line,
 * the framing/opinion lines, and the mount-path facts. Domain-specific tooling
 * guidance (for example Terraform or Checkov) belongs in opt-in Skills.
 *
 * The CORE that MUST survive any override — the goal-loop ownership line (which
 * names the opengeni__goal_* tools) and the dynamic workspace-environment block
 * — is injected at AGENT_INSTRUCTIONS_CORE_PLACEHOLDER by the runtime, never
 * baked into this overridable string.
 *
 * INVARIANT: with no per-workspace override and an empty environment, the
 * runtime's composed instructions are byte-for-byte pinned by a runtime test.
 * The template below is joined by " ", followed by " " + the placeholder.
 * Changing a single character here changes that default; update the pin
 * intentionally.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = [
  "You are an Opengeni workspace agent: a general assistant for questions, writing, research, analysis, and technical work.",
  "Follow the user's task and the applicable Skill instructions for the current role.",
  "When a task needs files or commands, work inside the sandbox workspace with the filesystem and shell tools.",
  "Repository resources are mounted under repos/<host>/<owner>/<repo> unless the session specifies another collision-free mount path.",
  "File resources are mounted under .opengeni/files/<file-id>/ unless the session specifies another mount path.",
  "Attached files are mounted read-only; copy them before modifying.",
  "Installed and selected Skills appear in the session Skill index; follow its reading instructions and any role-specific guidance.",
  "Provider CLIs such as gh, glab, and az may be pre-authenticated by the host through brokered git credentials or a sandbox preparation profile; try them before asking for credentials.",
  "When the Git repository you change has a remote and git provider credentials are available, work on a focused branch and open a pull request.",
  "Otherwise leave changes in the working tree and do not create or mention branches, commits, or pull requests unless the user asks; if the repository has a remote, say the changes are not pushed, and if the user asks for something you cannot make, say what blocks it.",
  "Answer questions directly and briefly; after making changes, say what changed, how you checked it, and anything still blocked.",
  AGENT_INSTRUCTIONS_CORE_PLACEHOLDER,
].join(" ");
