import { describe, expect, test } from "bun:test";
import type { ExecuteImageGenerationOperationInput } from "../src/activities/image-generation-operation";
import {
  executeXaiSubscriptionImageGeneration,
  type XaiImageGenerationPorts,
} from "../src/activities/xai-image-generation";

const receipt = {
  type: "generated_image",
  artifact: {
    available: true,
    artifactId: "55555555-5555-4555-8555-555555555555",
    kind: "generated_image",
    contentType: "image/png",
    originalBytes: 3,
    sha256: "c".repeat(64),
    retainedAt: "2026-08-12T00:00:00.000Z",
    dimensions: { width: 1, height: 1 },
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: "/v1/workspaces/11111111-1111-4111-8111-111111111111/artifacts/55555555-5555-4555-8555-555555555555/content",
      acceptRanges: "bytes",
      maxRangeBytes: 1024 * 1024,
    },
  },
  sandboxPath:
    "/workspace/generated-images/generated-image-55555555-5555-4555-8555-555555555555.png",
} as const;

function baseInput() {
  return {
    db: {} as never,
    objectStorage: null,
    accountId: "66666666-6666-4666-8666-666666666666",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    turnId: "33333333-3333-4333-8333-333333333333",
    attemptId: "44444444-4444-4444-8444-444444444444",
    toolCallId: "call-image-1",
    prompt: "A clean architectural sketch",
    credentialId: "77777777-7777-4777-8777-777777777777",
    xaiContext: {
      getToken: async () => ({ accessToken: "access", userId: "xai-user" }),
      refresh: async () => ({ accessToken: "refresh", userId: "xai-user" }),
    },
  };
}

describe("SuperGrok image adapter", () => {
  test("binds the durable operation to the frozen credential and xAI image model", async () => {
    let execution: ExecuteImageGenerationOperationInput | null = null;
    let generatedInput: Parameters<XaiImageGenerationPorts["generate"]>[0] | null = null;
    const ports: XaiImageGenerationPorts = {
      execute: async (input) => {
        execution = input;
        const generated = await input.generate();
        expect(generated).toMatchObject({
          toolCallId: "call-image-1",
          providerItemId: null,
          declaredMediaType: "image/png",
        });
        return receipt as never;
      },
      generate: async (input) => {
        generatedInput = input;
        return {
          bytes: Uint8Array.of(1, 2, 3),
          declaredMediaType: "image/png",
        };
      },
    };

    expect(await executeXaiSubscriptionImageGeneration(baseInput(), ports)).toBe(receipt);
    expect(execution).toMatchObject({
      providerId: "supergrok-subscription",
      modelId: "grok-imagine-image-quality",
    });
    expect("credentialId" in execution!).toBe(false);
    expect("xaiContext" in execution!).toBe(false);
    expect(execution?.providerBindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(execution)).not.toContain(baseInput().credentialId);
    expect(generatedInput?.prompt).toBe("A clean architectural sketch");
    expect(await generatedInput?.getToken()).toEqual({
      accessToken: "access",
      userId: "xai-user",
    });
    expect(await generatedInput?.refresh()).toEqual({
      accessToken: "refresh",
      userId: "xai-user",
    });
  });

  test("passes sealed reference images to the xAI edit route", async () => {
    let generatedInput: Parameters<XaiImageGenerationPorts["generate"]>[0] | null = null;
    const result = await executeXaiSubscriptionImageGeneration(
      {
        ...baseInput(),
        references: [
          {
            mediaType: "image/png",
            bytes: Uint8Array.of(1),
            sizeBytes: 1,
            sha256: "a".repeat(64),
          },
        ],
      },
      {
        execute: async (input) => {
          await input.generate();
          return receipt as never;
        },
        generate: async (input) => {
          generatedInput = input;
          return {
            bytes: Uint8Array.of(1, 2, 3),
            declaredMediaType: "image/png",
          };
        },
      },
    );
    expect(result).toBe(receipt);
    expect(generatedInput?.references).toEqual([
      { mediaType: "image/png", bytes: Uint8Array.of(1) },
    ]);
  });
});
