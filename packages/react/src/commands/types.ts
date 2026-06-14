import type { Permission, SessionStatus } from "@opengeni/sdk";
import type { SessionClientLike } from "../client";

/**
 * The slash-command registry. A command is a SESSION / OPERATOR control — an
 * action on the session or the UI (clear, compact, pause the goal, show help) —
 * NOT a structured way to talk to the agent. The human↔agent channel stays
 * plain chat; the palette only recognizes a leading "/" and never sends a
 * command to the model.
 *
 * Two kinds, modeled by where the handler does its work:
 *  - CLIENT commands touch only the local UI (e.g. /help, /clear-view).
 *  - SERVER commands call the API through the SDK (e.g. /clear, /compact,
 *    /goal).
 * Both are just `run(args, ctx)`; `ctx` exposes the client for server commands
 * and the UI affordances (notice, openHelp, clearView, confirm) for both.
 */

/** A positional argument a command accepts after its name. */
export type SlashArg = {
  name: string;
  /** Enter runs only once every required arg is present; otherwise autocompletes. */
  required?: boolean;
  /** Closed value set (rendered as a hint; validated by the command itself). */
  oneOf?: readonly string[];
  description?: string;
};

/** Transient feedback surfaced in the composer (generalized error line). */
export type Notice = { tone: "ok" | "error"; message: string };

/** Everything a command handler can reach. Assembled by the composer. */
export type CommandContext = {
  /** SDK-shaped client for server commands. */
  client: SessionClientLike;
  workspaceId: string;
  /** Null before a session exists (server commands should guard on this). */
  sessionId: string | null;
  status: SessionStatus | null;
  /** The operator's permissions on this workspace (gates command visibility). */
  permissions: Permission[];
  /** Surface a transient ok/error notice in the composer. */
  notice: (notice: Notice) => void;
  /** Open the in-composer /help panel (rendered from the registry). */
  openHelp: () => void;
  /**
   * Reset only the LOCAL timeline view — no server call. Returns whether a
   * view-reset affordance was actually wired (and thus had an effect): the host
   * surface supplies one via the composer's `onClearView` prop, and consoles
   * that don't (no resettable local timeline) get `false`. The /clear-view
   * command uses this to avoid reporting a false "cleared" success on a no-op.
   */
  clearView: () => boolean;
  /** Show the danger confirm bar; resolves true once the operator confirms. */
  confirm: () => Promise<boolean>;
};

export type CommandResult = {
  status: "ok" | "error";
  message?: string;
};

export type SlashCommand = {
  /** Primary token after the slash (no leading "/"). */
  name: string;
  /** Alternate tokens that resolve to this command. */
  aliases?: readonly string[];
  description: string;
  args?: readonly SlashArg[];
  /** Required permission; the command is hidden from the palette without it. */
  permission?: Permission;
  /** Destructive — the palette shows a confirm bar before running. */
  danger?: boolean;
  /**
   * Dynamic availability beyond the permission gate (e.g. hide a server command
   * until a session exists). Returning false hides the command.
   */
  available?: (ctx: Pick<CommandContext, "sessionId" | "status" | "permissions">) => boolean;
  /** Execute the command. Throwing is caught and surfaced as an error notice. */
  run: (args: string[], ctx: CommandContext) => Promise<CommandResult> | CommandResult;
};
