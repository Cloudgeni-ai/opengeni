import type { NativeCallCommand } from "@opengeni/react-native";

/**
 * A spoken command for one chat: "Call <name> in Opengeni" to Siri (or the
 * launcher shortcut on Android) starts a call straight into that chat. Each
 * account keeps its own; only the signed-in account's reach the system.
 */
export type VoiceCommand = {
  /** Stable across renames, so shortcuts built on it keep working. */
  id: string;
  workspaceId: string;
  sessionId: string;
  /** What the person says. */
  name: string;
  /** The chat's title when the command was made, to recognize it in lists. */
  chatTitle: string;
  createdAt: string;
  /** The chat was deleted (or is out of reach): the command no longer calls. */
  missing?: boolean;
};

/** Siri hears short names best; longer ones are also hard to say the same way twice. */
export const VOICE_COMMAND_NAME_MAX = 32;

export type VoiceCommandNameProblem = "empty" | "tooLong" | "taken" | "appName";

/** The name as it is stored and said: trimmed, single spaces. */
export function normalizeVoiceCommandName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function sameName(a: string, b: string): boolean {
  return (
    normalizeVoiceCommandName(a).localeCompare(normalizeVoiceCommandName(b), undefined, {
      sensitivity: "base",
    }) === 0
  );
}

/**
 * A short name to start from: the chat's agent when it has its own name
 * ("Atlas"), else the first few words of the chat's title.
 */
export function suggestedVoiceCommandName(input: {
  agentName?: string | null | undefined;
  title?: string | null | undefined;
  appName: string;
}): string {
  const agent = normalizeVoiceCommandName(input.agentName ?? "");
  if (agent && !sameName(agent, input.appName) && agent.length <= VOICE_COMMAND_NAME_MAX) {
    return agent;
  }
  const words = normalizeVoiceCommandName(input.title ?? "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(" ")
    .filter(Boolean);
  let name = "";
  for (const word of words.slice(0, 3)) {
    const next = name ? `${name} ${word}` : word;
    if (next.length > 24) break;
    name = next;
  }
  return name;
}

/** Why a name can't be used, or null. `exceptId` is the command being renamed. */
export function voiceCommandNameProblem(
  raw: string,
  commands: readonly VoiceCommand[],
  options: { appName: string; exceptId?: string | undefined },
): VoiceCommandNameProblem | null {
  const name = normalizeVoiceCommandName(raw);
  if (!name) return "empty";
  if (name.length > VOICE_COMMAND_NAME_MAX) return "tooLong";
  // "Call Opengeni in Opengeni" is the default call's phrase already.
  if (sameName(name, options.appName)) return "appName";
  if (commands.some((each) => each.id !== options.exceptId && sameName(each.name, name))) {
    return "taken";
  }
  return null;
}

export function voiceCommandNameMessage(problem: VoiceCommandNameProblem, appName: string): string {
  switch (problem) {
    case "empty":
      return "Type the name you'll say.";
    case "tooLong":
      return `Keep it under ${VOICE_COMMAND_NAME_MAX + 1} characters, so it's quick to say.`;
    case "appName":
      return `“${appName}” already starts your usual call. Pick a name for this chat.`;
    case "taken":
      return "Another chat already has this name.";
  }
}

export function voiceCommandForSession(
  commands: readonly VoiceCommand[],
  workspaceId: string,
  sessionId: string,
): VoiceCommand | null {
  return (
    commands.find((each) => each.workspaceId === workspaceId && each.sessionId === sessionId) ??
    null
  );
}

/** What the system offers by name: every command whose chat still exists. */
export function nativeCallCommands(commands: readonly VoiceCommand[]): NativeCallCommand[] {
  return commands
    .filter((each) => !each.missing)
    .map((each) => ({
      id: each.id,
      workspaceId: each.workspaceId,
      sessionId: each.sessionId,
      name: each.name,
    }));
}

/** Stored commands, dropping anything malformed. */
export function parseVoiceCommands(raw: string | null): VoiceCommand[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown): VoiceCommand[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
      const command: VoiceCommand = {
        id: text("id"),
        workspaceId: text("workspaceId"),
        sessionId: text("sessionId"),
        name: normalizeVoiceCommandName(text("name")),
        chatTitle: text("chatTitle"),
        createdAt: text("createdAt"),
        ...(value.missing === true ? { missing: true } : {}),
      };
      return command.id && command.workspaceId && command.sessionId && command.name
        ? [command]
        : [];
    });
  } catch {
    return [];
  }
}
