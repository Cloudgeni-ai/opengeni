import { describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { decryptEnvironmentValue } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  managedVideoGenerationCredentialLease,
  videoCapabilitiesForTurn,
} from "../src/activities/video-generation-admission";

describe("video generation funding binding", () => {
  test("snapshots the managed Gateway credential without exposing it in capabilities", () => {
    const settings = testSettings({
      vercelAiGatewayApiKey: "managed-video-gateway-key",
      environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
    });
    const credential = managedVideoGenerationCredentialLease(settings);
    expect(credential).toMatchObject({
      fundingSource: "opengeni_credits",
      connectionId: null,
      version: 1,
      apiKey: "managed-video-gateway-key",
    });
    const encryptionKey = environmentsEncryptionKeyBytes(settings);
    if (!credential || !encryptionKey) throw new Error("managed credential was not created");
    expect(credential.credentialEncrypted).not.toContain(credential.apiKey);
    expect(
      JSON.parse(decryptEnvironmentValue(encryptionKey, credential.credentialEncrypted)),
    ).toEqual({ apiKey: credential.apiKey });

    const capabilities = videoCapabilitiesForTurn({
      policy: {
        schemaVersion: 1,
        revision: 1,
        fundingSource: "opengeni_credits",
        enabledModelIds: ["bytedance/seedance-2.5"],
        defaultModelId: "bytedance/seedance-2.5",
      },
      credential,
    });
    expect(JSON.stringify(capabilities)).not.toContain(credential.apiKey);
  });

  test("fails closed when policy and credential funding differ", () => {
    expect(() =>
      videoCapabilitiesForTurn({
        policy: {
          schemaVersion: 1,
          revision: 1,
          fundingSource: "workspace_gateway",
          enabledModelIds: ["bytedance/seedance-2.5"],
          defaultModelId: "bytedance/seedance-2.5",
        },
        credential: {
          fundingSource: "opengeni_credits",
          connectionId: null,
          version: 1,
          credentialEncrypted: "encrypted",
          apiKey: "secret",
        },
      }),
    ).toThrow("funding changed");
  });
});
