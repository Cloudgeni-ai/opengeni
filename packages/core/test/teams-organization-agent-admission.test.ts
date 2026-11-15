import { expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { authorizeTeamsConversationAdmission } from "../src/application/teams-private-session";

const agentId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  accountId: crypto.randomUUID(),
  workspaceId,
  subjectId: `teams-agent:${agentId}`,
  subjectLabel: "Auditor",
  permissions: ["sessions:create", "sessions:read"],
  permissionMode: "explicit",
  principalKind: "service",
  serviceInitiator: { kind: "service", subjectId: `teams-agent:${agentId}`, label: "Auditor" },
  serviceInitiatorContext: { teamsAgentId: agentId, opengeniSubjectId: "user:asker" },
  ...overrides,
});
const admit = (g: AccessGrant, extra: { privateCreate?: boolean; routing?: boolean } = {}) =>
  authorizeTeamsConversationAdmission(
    {
      db: {} as never,
      settings: testSettings({ teamsWorkspaceRoutingEnabled: extra.routing ?? true }),
    },
    g,
    {
      workspaceId,
      sessionId: crypto.randomUUID(),
      creating: true,
      personal: true,
      initialMessage: "hello",
      ...(extra.privateCreate ? { privateCreate: true } : {}),
      proof: {
        routeId: `teams-agent:${"0".repeat(64)}`,
        eventId: "event",
        leaseToken: crypto.randomUUID(),
        installationGeneration: crypto.randomUUID(),
      },
    },
  );

test("an organization agent's Teams chat is admitted only for its own service grant, with routing on", async () => {
  for (const [forged, extra] of [
    [grant({ principalKind: "user" }), {}],
    [grant({ serviceInitiatorContext: { teamsAgentId: agentId } }), {}],
    [
      grant({
        serviceInitiatorContext: { teamsAgentId: agentId, opengeniSubjectId: "teams-agent:x" },
      }),
      {},
    ],
    [
      grant({
        serviceInitiatorContext: {
          teamsAgentId: crypto.randomUUID(),
          opengeniSubjectId: "user:asker",
        },
      }),
      {},
    ],
    [grant(), { privateCreate: true }],
    [grant(), { routing: false }],
  ] as const)
    await expect(admit(forged, extra)).rejects.toThrow("teams_private_session_proof_invalid");
});
