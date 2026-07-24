import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_PROTOCOL_EVIDENCE,
  codexRealtimeAvailability,
  createCodexRealtimeGatewayGrant,
} from "../src/realtime";

const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
};

describe("Codex realtime voice boundary", () => {
  test("keeps the production protocol explicitly unverified", () => {
    expect(CODEX_REALTIME_PROTOCOL_EVIDENCE).toEqual({
      status: "unverified",
      endpoint: null,
      transport: null,
      reason: "codex_realtime_protocol_unverified",
    });
    expect(
      codexRealtimeAvailability({
        featureEnabled: true,
        subscriptionEnabled: true,
        workspacePolicyAccepted: true,
      }),
    ).toMatchObject({ status: "unavailable", reason: "codex_realtime_protocol_unverified" });
  });

  test("fails before resolving a subscription credential when protocol proof is absent", async () => {
    let credentialReads = 0;
    let gatewayCalls = 0;
    const result = await createCodexRealtimeGatewayGrant({
      availability: {
        featureEnabled: true,
        subscriptionEnabled: true,
        workspacePolicyAccepted: true,
      },
      target,
      resolveCredential: async () => {
        credentialReads += 1;
        return { accessToken: "must-not-be-read" };
      },
      openServerGateway: async () => {
        gatewayCalls += 1;
        throw new Error("must not open");
      },
    });
    expect(result).toMatchObject({
      availability: { reason: "codex_realtime_protocol_unverified" },
      grant: null,
    });
    expect(credentialReads).toBe(0);
    expect(gatewayCalls).toBe(0);
  });

  test("returns only an opaque OpenGeni grant after an injected verified server handshake", async () => {
    const result = await createCodexRealtimeGatewayGrant({
      availability: {
        featureEnabled: true,
        subscriptionEnabled: true,
        workspacePolicyAccepted: true,
        gatewayAvailable: true,
        protocol: {
          status: "verified",
          endpoint: "https://subscription.example.test/realtime",
          transport: "websocket",
          reason: null,
        },
      },
      target,
      resolveCredential: async () => ({
        accessToken: "server-only-token",
        chatgptAccountId: "server-only-account",
      }),
      openServerGateway: async ({ credential }) => {
        expect(credential.accessToken).toBe("server-only-token");
        return {
          id: "33333333-3333-4333-8333-333333333333",
          gatewayUrl: "wss://api.example.test/realtime/33333333",
          expiresAt: "2026-07-24T22:30:00.000Z",
        };
      },
    });
    expect(result.grant).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("server-only-token");
    expect(serialized).not.toContain("server-only-account");
    expect(serialized).not.toContain("accessToken");
  });

  test("cannot claim availability from protocol evidence without a real gateway", async () => {
    let credentialReads = 0;
    const protocol = {
      status: "verified" as const,
      endpoint: "https://subscription.example.test/realtime",
      transport: "websocket" as const,
      reason: null,
    };
    expect(
      codexRealtimeAvailability({
        featureEnabled: true,
        subscriptionEnabled: true,
        workspacePolicyAccepted: true,
        protocol,
      }),
    ).toMatchObject({ status: "unavailable", reason: "gateway_unavailable" });
    const result = await createCodexRealtimeGatewayGrant({
      availability: {
        featureEnabled: true,
        subscriptionEnabled: true,
        workspacePolicyAccepted: true,
        protocol,
      },
      target,
      resolveCredential: async () => {
        credentialReads += 1;
        return { accessToken: "must-not-be-read" };
      },
      openServerGateway: async () => {
        throw new Error("must not open");
      },
    });
    expect(result.grant).toBeNull();
    expect(credentialReads).toBe(0);
  });

  test("keeps realtime voice consent separate after protocol and gateway verification", () => {
    expect(
      codexRealtimeAvailability({
        featureEnabled: true,
        subscriptionEnabled: true,
        workspacePolicyAccepted: false,
        gatewayAvailable: true,
        protocol: {
          status: "verified",
          endpoint: "https://subscription.example.test/realtime",
          transport: "websocket",
          reason: null,
        },
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "realtime_voice_policy_unaccepted",
      workspacePolicy: "unaccepted",
    });
  });
});
