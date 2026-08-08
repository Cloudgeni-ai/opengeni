import { describe, expect, test } from "bun:test";
import {
  executeImageGenerationOperation,
  ImageGenerationOutcomeUnknownError,
  imageGenerationOperationIdentity,
  imageProviderBindingHash,
  type ExecuteImageGenerationOperationInput,
  type ImageGenerationOperationPorts,
} from "../src/activities/image-generation-operation";
import type { GeneratedImageReceipt } from "../src/activities/generated-images";

const base = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  toolCallId: "call_generate_1",
  providerId: "vercel-ai-gateway",
  providerBindingHash: "a".repeat(64),
  modelId: "openai/gpt-image-2",
  prompt: "A clean architectural sketch",
};

const receipt = {
  type: "generated_image",
  artifact: {
    available: true,
    artifactId: "55555555-5555-4555-8555-555555555555",
    kind: "generated_image",
    contentType: "image/png",
    originalBytes: 1,
    sha256: "c".repeat(64),
    retainedAt: "2026-08-08T00:00:00.000Z",
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
} satisfies GeneratedImageReceipt;

function executionInput(generateCalls: { count: number }): ExecuteImageGenerationOperationInput {
  return {
    ...base,
    attemptId: "44444444-4444-4444-8444-444444444444",
    accountId: "66666666-6666-4666-8666-666666666666",
    db: {} as ExecuteImageGenerationOperationInput["db"],
    objectStorage: null,
    generate: async () => {
      generateCalls.count += 1;
      return {
        toolCallId: base.toolCallId,
        providerItemId: null,
        bytes: Uint8Array.of(1),
        declaredMediaType: "image/png",
      };
    },
  };
}

function operationPorts(
  overrides: Partial<ImageGenerationOperationPorts> = {},
): ImageGenerationOperationPorts {
  return {
    prepare: async () => ({
      operation: { status: "prepared" } as never,
      created: true,
    }),
    begin: async () => ({
      operation: { status: "provider_started" } as never,
      started: true,
    }),
    retain: async () => ({ receipt, artifact: {} as never }),
    complete: async () => ({ status: "completed" }) as never,
    markOutcomeUnknown: async () => ({ status: "outcome_unknown" }) as never,
    recover: async () => null,
    ...overrides,
  };
}

describe("image generation operation identity", () => {
  test("is deterministic at the durable turn/tool boundary", () => {
    expect(imageGenerationOperationIdentity(base)).toEqual(imageGenerationOperationIdentity(base));
    expect(imageGenerationOperationIdentity(base)).toMatchObject({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      operationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      artifactId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test("separates execution identity from request integrity", () => {
    const original = imageGenerationOperationIdentity(base);
    const changedPrompt = imageGenerationOperationIdentity({
      ...base,
      prompt: "Different prompt",
    });
    expect(changedPrompt.operationKey).toBe(original.operationKey);
    expect(changedPrompt.operationId).toBe(original.operationId);
    expect(changedPrompt.artifactId).toBe(original.artifactId);
    expect(changedPrompt.requestDigest).not.toBe(original.requestDigest);

    const changedCall = imageGenerationOperationIdentity({
      ...base,
      toolCallId: "call_generate_2",
    });
    expect(changedCall.operationKey).not.toBe(original.operationKey);
    expect(changedCall.artifactId).not.toBe(original.artifactId);
  });

  test("never exposes raw credential material in provider binding identity", () => {
    const secret = "sensitive-workspace-key";
    const binding = imageProviderBindingHash("vercel-ai-gateway", secret);
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
    expect(binding).not.toContain(secret);
    expect(() => imageProviderBindingHash("", secret)).toThrow("empty");
  });
});

describe("image generation paid-operation fence", () => {
  test("runs the provider once only after durable admission, then retains before completion", async () => {
    const calls: string[] = [];
    const generateCalls = { count: 0 };
    const input = executionInput(generateCalls);
    const result = await executeImageGenerationOperation(
      {
        ...input,
        generate: async () => {
          calls.push("provider");
          return await input.generate();
        },
      },
      operationPorts({
        prepare: async () => {
          calls.push("prepare");
          return { operation: { status: "prepared" } as never, created: true };
        },
        begin: async () => {
          calls.push("begin");
          return {
            operation: { status: "provider_started" } as never,
            started: true,
          };
        },
        retain: async () => {
          calls.push("retain");
          return { receipt, artifact: {} as never };
        },
        complete: async () => {
          calls.push("complete");
          return { status: "completed" } as never;
        },
      }),
    );
    expect(result).toEqual(receipt);
    expect(generateCalls.count).toBe(1);
    expect(calls).toEqual(["prepare", "begin", "provider", "retain", "complete"]);
  });

  test("recovers a completed artifact without invoking the provider", async () => {
    const generateCalls = { count: 0 };
    let recoveries = 0;
    expect(
      await executeImageGenerationOperation(
        executionInput(generateCalls),
        operationPorts({
          prepare: async () => ({
            operation: { status: "provider_started" } as never,
            created: false,
          }),
          recover: async () => {
            recoveries += 1;
            return receipt;
          },
        }),
      ),
    ).toEqual(receipt);
    expect(generateCalls.count).toBe(0);
    expect(recoveries).toBe(1);
  });

  test("never replays a started operation whose outcome cannot be recovered", async () => {
    const generateCalls = { count: 0 };
    await expect(
      executeImageGenerationOperation(
        executionInput(generateCalls),
        operationPorts({
          prepare: async () => ({
            operation: { status: "outcome_unknown" } as never,
            created: false,
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(ImageGenerationOutcomeUnknownError);
    expect(generateCalls.count).toBe(0);
  });

  test("fences provider or retention failures as outcome-unknown", async () => {
    for (const failure of ["provider", "retention"] as const) {
      const generateCalls = { count: 0 };
      let fenced = 0;
      const input = executionInput(generateCalls);
      await expect(
        executeImageGenerationOperation(
          {
            ...input,
            generate:
              failure === "provider"
                ? async () => {
                    generateCalls.count += 1;
                    throw new Error("provider failed ambiguously");
                  }
                : input.generate,
          },
          operationPorts({
            retain:
              failure === "retention"
                ? async () => {
                    throw new Error("retention failed");
                  }
                : operationPorts().retain,
            markOutcomeUnknown: async () => {
              fenced += 1;
              return { status: "outcome_unknown" } as never;
            },
          }),
        ),
      ).rejects.toThrow("failed");
      expect(generateCalls.count).toBe(1);
      expect(fenced).toBe(1);
    }
  });
});
