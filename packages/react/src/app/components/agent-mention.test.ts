import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@opengeni/sdk";

import { agentMentionContext, mentionedAgentProfiles } from "./agent-mention";

function profile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: crypto.randomUUID(),
    name: "Annie",
    role: null,
    avatar: { kind: "emoji", emoji: "🦉", hue: 235 },
    config: {},
    version: 1,
    status: "active",
    homeSessionId: null,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  } as AgentProfile;
}

describe("agent mentions", () => {
  test("finds whole-name mentions in order", () => {
    const annie = profile({ name: "Annie" });
    const bug = profile({ name: "Bugfixer" });
    expect(
      mentionedAgentProfiles("ask @bugfixer then @Annie, not @Annies", [annie, bug]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Bugfixer", "Annie"]);
    expect(agentMentionContext("no mentions here", [annie])).toBeUndefined();
  });

  test("routes to a home chat unless the message is sent in it", () => {
    const home = crypto.randomUUID();
    const annie = profile({ name: "Annie", role: "PR reviewer", homeSessionId: home });
    const scout = profile({ name: "Scout" });

    const elsewhere = agentMentionContext("@Annie review #12 and @Scout look", [annie, scout]);
    expect(elsewhere).toContain(
      `- @Annie: agentProfileId=${annie.id}, home chat sessionId=${home} (PR reviewer)`,
    );
    expect(elsewhere).toContain(`- @Scout: agentProfileId=${scout.id}\n`);
    expect(elsewhere).toContain("session_send_message");

    const inHome = agentMentionContext("@Annie review #12", [annie], home);
    expect(inHome).toContain("this chat is its home chat");
    expect(inHome).not.toContain(`sessionId=${home}`);
  });
});
