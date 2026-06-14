import type { Permission } from "@opengeni/sdk";
import type { CommandContext, SlashArg, SlashCommand } from "./types";

/**
 * Parse a composer value into a command name + the rest. A command is
 * recognized ONLY when the value's first character is "/" (the start token);
 * anything else is plain chat and returns null.
 *
 * "/cl"        -> { name: "cl", rest: "", hasTrailingSpace: false }
 * "/goal "     -> { name: "goal", rest: "", hasTrailingSpace: true }
 * "/goal pause"-> { name: "goal", rest: "pause", hasTrailingSpace: false }
 */
export type ParsedCommandLine = {
  name: string;
  rest: string;
  /** True when the name token is closed by a space — arg-hint mode. */
  hasTrailingSpace: boolean;
  args: string[];
};

export function parseCommandLine(value: string): ParsedCommandLine | null {
  if (value[0] !== "/") {
    return null;
  }
  const body = value.slice(1);
  const firstSpace = body.indexOf(" ");
  if (firstSpace === -1) {
    return { name: body, rest: "", hasTrailingSpace: false, args: [] };
  }
  const name = body.slice(0, firstSpace);
  const rest = body.slice(firstSpace + 1);
  return {
    name,
    rest,
    hasTrailingSpace: true,
    args: rest.split(/\s+/).filter((token) => token.length > 0),
  };
}

const PERMISSION_SUPERUSER: Permission = "workspace:admin";

/** Whether the operator's permission set satisfies a command's gate. */
export function hasPermission(required: Permission | undefined, permissions: Permission[]): boolean {
  if (!required) {
    return true;
  }
  return permissions.includes(required) || permissions.includes(PERMISSION_SUPERUSER);
}

/** Match a command (by name or alias) against the value. */
export function matchCommand(commands: readonly SlashCommand[], value: string): SlashCommand | null {
  const parsed = parseCommandLine(value);
  if (!parsed) {
    return null;
  }
  const token = parsed.name.toLowerCase();
  return commands.find((command) => command.name === token || command.aliases?.includes(token)) ?? null;
}

type FilterCtx = Pick<CommandContext, "sessionId" | "status" | "permissions">;

/**
 * The commands visible for the current token + context. Permission-absent and
 * `available()===false` commands are dropped entirely (a gated command is never
 * shown, not shown-disabled). Filtering is a prefix match on name/alias.
 */
export function filterCommands(commands: readonly SlashCommand[], token: string, ctx: FilterCtx): SlashCommand[] {
  const needle = token.toLowerCase();
  return commands.filter((command) => {
    if (!hasPermission(command.permission, ctx.permissions)) {
      return false;
    }
    if (command.available && !command.available(ctx)) {
      return false;
    }
    if (needle.length === 0) {
      return true;
    }
    return command.name.startsWith(needle) || (command.aliases?.some((alias) => alias.startsWith(needle)) ?? false);
  });
}

/** Render a command's arg hint for the palette footer / help, e.g. "<pause|resume>". */
export function argHint(args: readonly SlashArg[] | undefined): string {
  if (!args || args.length === 0) {
    return "";
  }
  return args
    .map((arg) => {
      const label = arg.oneOf ? arg.oneOf.join("|") : arg.name;
      return arg.required ? `<${label}>` : `[${label}]`;
    })
    .join(" ");
}

/** The first required arg that has not yet been supplied, if any. */
export function firstMissingRequiredArg(command: SlashCommand, args: string[]): SlashArg | null {
  const required = (command.args ?? []).filter((arg) => arg.required);
  for (let i = 0; i < required.length; i += 1) {
    const value = args[i];
    if (value === undefined || value.length === 0) {
      return required[i] ?? null;
    }
  }
  return null;
}

function requireSession(ctx: CommandContext): string {
  if (!ctx.sessionId) {
    throw new Error("No active session yet — start a session first.");
  }
  return ctx.sessionId;
}

const hasSession = (ctx: FilterCtx): boolean => ctx.sessionId !== null;

/**
 * The default command set. Adding a command is one object literal here; the
 * palette list, filter, arg-hint footer, and /help all render from this array.
 * Apps concat their own commands via the ChatComposer `commands` prop.
 */
export const defaultCommands: readonly SlashCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    description: "Show available commands.",
    run: (_args, ctx) => {
      ctx.openHelp();
      return { status: "ok" };
    },
  },
  {
    name: "clear-view",
    description: "Clear the local timeline view (this device only; no server change).",
    run: (_args, ctx) => {
      // clearView() reports whether the host actually wired a view-reset. If it
      // didn't (the console surface has no resettable local timeline), reporting
      // "Local view cleared." would be a false success — return an honest error
      // instead so the operator isn't told something happened when nothing did.
      const cleared = ctx.clearView();
      if (!cleared) {
        return { status: "error", message: "This view can't be cleared here (no local timeline to reset)." };
      }
      return { status: "ok", message: "Local view cleared." };
    },
  },
  {
    name: "goal",
    description: "Pause or resume the session's goal loop.",
    permission: "sessions:control",
    available: hasSession,
    args: [{ name: "action", required: true, oneOf: ["pause", "resume"], description: "pause | resume" }],
    run: async (args, ctx) => {
      const sessionId = requireSession(ctx);
      const action = args[0];
      if (action !== "pause" && action !== "resume") {
        return { status: "error", message: "Usage: /goal pause | /goal resume" };
      }
      try {
        await ctx.client.updateGoal(ctx.workspaceId, sessionId, { status: action === "pause" ? "paused" : "active" });
        return { status: "ok", message: action === "pause" ? "Goal paused." : "Goal resumed." };
      } catch (cause) {
        return { status: "error", message: goalErrorMessage(cause, action) };
      }
    },
  },
  {
    name: "compact",
    description: "Compact the conversation context now.",
    permission: "sessions:control",
    available: hasSession,
    run: async (_args, ctx) => {
      const sessionId = requireSession(ctx);
      try {
        const result = await ctx.client.compactSessionContext(ctx.workspaceId, sessionId);
        return { status: "ok", message: result.message };
      } catch (cause) {
        return { status: "error", message: errorMessage(cause) ?? "Could not compact context." };
      }
    },
  },
  {
    name: "clear",
    description: "Clear the conversation context (destructive; audit-preserved).",
    permission: "sessions:control",
    danger: true,
    available: hasSession,
    run: async (_args, ctx) => {
      const sessionId = requireSession(ctx);
      const confirmed = await ctx.confirm();
      if (!confirmed) {
        return { status: "ok" };
      }
      try {
        await ctx.client.clearSessionContext(ctx.workspaceId, sessionId);
        return { status: "ok", message: "Context cleared." };
      } catch (cause) {
        return { status: "error", message: clearErrorMessage(cause) };
      }
    },
  },
];

function errorMessage(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "message" in cause && typeof (cause as { message?: unknown }).message === "string") {
    return (cause as { message: string }).message;
  }
  return undefined;
}

function statusCode(cause: unknown): number | undefined {
  if (cause && typeof cause === "object" && "status" in cause && typeof (cause as { status?: unknown }).status === "number") {
    return (cause as { status: number }).status;
  }
  return undefined;
}

function goalErrorMessage(cause: unknown, action: "pause" | "resume"): string {
  const code = statusCode(cause);
  if (code === 404) {
    return "This session has no goal to control.";
  }
  if (code === 409) {
    return action === "resume" ? "Only a paused goal can be resumed." : "Goal is already in a terminal state.";
  }
  return errorMessage(cause) ?? `Could not ${action} the goal.`;
}

function clearErrorMessage(cause: unknown): string {
  if (statusCode(cause) === 409) {
    return "Can't clear context mid-turn — stop the current turn first.";
  }
  return errorMessage(cause) ?? "Could not clear context.";
}
