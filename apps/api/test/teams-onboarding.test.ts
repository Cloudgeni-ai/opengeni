import { describe, expect, test } from "bun:test";
import type { App } from "@microsoft/teams.apps";
import { sendTeamsOnboarding } from "../src/integrations/teams-bot";
import {
  mintTeamsProof,
  normalizeTeamsMessage,
  verifyTeamsProof,
} from "../src/integrations/teams-protocol";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const workspaceId = "10000000-0000-4000-8000-000000000003";
const generation = "10000000-0000-4000-8000-000000000004";
const message = normalizeTeamsMessage({
  type: "message",
  id: "message-1",
  timestamp: "2026-10-29T10:00:00Z",
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  from: { id: "29:human", aadObjectId: actorId },
  recipient: { id: "28:bot" },
  conversation: { id: "19:personal", conversationType: "personal", tenantId },
  channelData: { tenant: { id: tenantId } },
  text: "Hello",
})!;

function transport(receipt: { id?: string } = { id: "sent-1" }) {
  const calls: Array<{ serviceUrl: string; conversationId: string; activity: unknown }> = [];
  const app = {
    api: {
      fromServiceUrl: ({ serviceUrl }: { serviceUrl: string }) => ({
        conversations: {
          createActivity: async (conversationId: string, activity: unknown) => {
            calls.push({ serviceUrl, conversationId, activity });
            return receipt;
          },
        },
      }),
    },
  } as unknown as App;
  return { app, calls };
}

describe("Teams onboarding message delivery", () => {
  test.each(["setup", "link"] as const)(
    "%s sends a readable open-URL action with the exact proof fragment",
    async (purpose) => {
      const proof = {
        purpose,
        tenantId,
        actorId,
        workspaceId: purpose === "setup" ? null : workspaceId,
        generation: purpose === "setup" ? null : generation,
      };
      const token = mintTeamsProof("fixture-signing-secret", proof);
      const url = new URL(
        purpose === "setup" ? "/teams/connect" : `/workspaces/${workspaceId}/plugins`,
        "https://app.example.test",
      );
      url.hash = new URLSearchParams({
        [purpose === "setup" ? "teams_setup" : "teams_link"]: token,
      }).toString();
      const { app, calls } = transport();
      expect(await sendTeamsOnboarding(app, message, purpose, url.toString())).toBe("sent-1");
      const text =
        purpose === "setup"
          ? "Connect Teams to your Opengeni workspace."
          : "Link your Opengeni account to use this bot.";
      expect(calls).toEqual([
        {
          serviceUrl: message.serviceUrl,
          conversationId: message.conversationId,
          activity: {
            type: "message",
            text,
            textFormat: "plain",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: {
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.2",
                  actions: [
                    {
                      type: "Action.OpenUrl",
                      title: purpose === "setup" ? "Connect Teams" : "Link account",
                      url: url.toString(),
                    },
                  ],
                },
              },
            ],
          },
        },
      ]);
      // The only serialized occurrence is the action destination, never visible copy.
      expect(JSON.stringify(calls).split(token)).toHaveLength(2);
      expect(text).not.toContain(token);
      expect(
        verifyTeamsProof(
          "fixture-signing-secret",
          new URLSearchParams(url.hash.slice(1)).get(
            purpose === "setup" ? "teams_setup" : "teams_link",
          )!,
        ),
      ).toMatchObject(proof);
    },
  );

  test("refuses group/channel destinations before contacting the provider", async () => {
    const { app, calls } = transport();
    for (const groupChat of [false, true]) {
      await expect(
        sendTeamsOnboarding(
          app,
          { ...message, personal: false, groupChat },
          "link",
          "https://app.example.test/#teams_link=fixture",
        ),
      ).rejects.toThrow("teams_onboarding_requires_personal_chat");
    }
    expect(calls).toEqual([]);
  });

  test("keeps service-URL validation and requires a provider receipt", async () => {
    const { app, calls } = transport({});
    await expect(
      sendTeamsOnboarding(
        app,
        { ...message, serviceUrl: "https://untrusted.example.test/" },
        "setup",
        "https://app.example.test/#teams_setup=fixture",
      ),
    ).rejects.toThrow("teams_service_url_rejected");
    expect(calls).toEqual([]);
    await expect(
      sendTeamsOnboarding(app, message, "setup", "https://app.example.test/#teams_setup=fixture"),
    ).rejects.toThrow("teams_delivery_missing_receipt");
    expect(calls).toHaveLength(1);
  });
});
