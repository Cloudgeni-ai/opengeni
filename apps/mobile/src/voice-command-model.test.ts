import { describe, expect, test } from "bun:test";
import {
  nativeCallCommands,
  normalizeVoiceCommandName,
  parseVoiceCommands,
  suggestedVoiceCommandName,
  voiceCommandForSession,
  voiceCommandNameProblem,
  type VoiceCommand,
} from "./voice-command-model";

const research: VoiceCommand = {
  id: "c1",
  workspaceId: "w1",
  sessionId: "s1",
  name: "Research",
  chatTitle: "Market research",
  createdAt: "2026-11-11T10:00:00.000Z",
};

describe("voice command names", () => {
  test("start from the chat's agent name, else the first words of its title", () => {
    expect(
      suggestedVoiceCommandName({ agentName: "Scout", title: "Anything", appName: "Opengeni" }),
    ).toBe("Scout");
    expect(
      suggestedVoiceCommandName({
        agentName: "Opengeni",
        title: "Weekly planning",
        appName: "Opengeni",
      }),
    ).toBe("Weekly planning");
    expect(
      suggestedVoiceCommandName({
        title: "Investigate the flaky deployment pipeline on staging",
        appName: "Opengeni",
      }),
    ).toBe("Investigate the flaky");
    expect(suggestedVoiceCommandName({ title: "Q3: budget & hiring!", appName: "Opengeni" })).toBe(
      "Q3 budget hiring",
    );
    expect(suggestedVoiceCommandName({ title: "", appName: "Opengeni" })).toBe("");
  });

  test("must be said, short, not the app's own name, and unique in the account", () => {
    const options = { appName: "Opengeni" };
    expect(normalizeVoiceCommandName("  Deep   work ")).toBe("Deep work");
    expect(voiceCommandNameProblem("   ", [], options)).toBe("empty");
    expect(voiceCommandNameProblem("x".repeat(33), [], options)).toBe("tooLong");
    expect(voiceCommandNameProblem("opengeni", [], options)).toBe("appName");
    expect(voiceCommandNameProblem("research ", [research], options)).toBe("taken");
    expect(voiceCommandNameProblem("Résearch", [research], options)).toBe("taken");
    // Renaming a command to its own name (or a new casing of it) is fine.
    expect(
      voiceCommandNameProblem("RESEARCH", [research], { ...options, exceptId: "c1" }),
    ).toBeNull();
    expect(voiceCommandNameProblem("Planning", [research], options)).toBeNull();
  });
});

describe("voice command catalog", () => {
  test("only commands whose chat still exists reach the system", () => {
    const gone = { ...research, id: "c2", sessionId: "s2", name: "Old", missing: true };
    expect(nativeCallCommands([research, gone])).toEqual([
      { id: "c1", workspaceId: "w1", sessionId: "s1", name: "Research" },
    ]);
  });

  test("finds a chat's command by workspace and session", () => {
    expect(voiceCommandForSession([research], "w1", "s1")).toBe(research);
    expect(voiceCommandForSession([research], "w2", "s1")).toBeNull();
  });

  test("reads stored commands and drops malformed ones", () => {
    const stored = JSON.stringify([
      { ...research, name: " Research  team " },
      { id: "c3", workspaceId: "w1", name: "No session" },
      "junk",
      { ...research, id: "c4", sessionId: "s4", missing: true },
    ]);
    expect(parseVoiceCommands(stored)).toEqual([
      { ...research, name: "Research team" },
      { ...research, id: "c4", sessionId: "s4", missing: true },
    ]);
    expect(parseVoiceCommands("{")).toEqual([]);
    expect(parseVoiceCommands(null)).toEqual([]);
  });
});
