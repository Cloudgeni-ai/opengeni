import { describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  managedVideoGenerationCredentialLease,
  videoCapabilitiesForTurn,
} from "../src/activities/video-generation-admission";
import { decryptVideoGenerationCredential } from "../src/activities/video-generation-credential";

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
    });
    const encryptionKey = environmentsEncryptionKeyBytes(settings);
    if (!credential || !encryptionKey) throw new Error("managed credential was not created");
    expect(credential.credentialEncrypted).not.toContain("managed-video-gateway-key");
    expect(decryptVideoGenerationCredential(encryptionKey, credential.credentialEncrypted)).toEqual(
      { kind: "api-key", apiKey: "managed-video-gateway-key" },
    );

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
    expect(JSON.stringify(capabilities)).not.toContain("managed-video-gateway-key");
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
        },
      }),
    ).toThrow("funding changed");
  });
});
