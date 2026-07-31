import { describe, expect, spyOn, test } from "bun:test";
import * as dbModule from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createTranscriptionService } from "../src/transcription/service";

const audio = new Uint8Array([1, 2, 3]);

describe("transcription providers", () => {
  test("posts OpenAI multipart request with the configured model", async () => {
    let request: Request | undefined;
    const service = createTranscriptionService({
      settings: testSettings({
        voiceInputProviderOrder: "openai",
        voiceInputOpenaiModel: "gpt-transcribe",
      }),
      db: {} as never,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ text: "hello", language: "en" });
      },
    });
    const result = await service.transcribe({
      workspaceId: "workspace",
      accountId: "account",
      audio,
      mimeType: "audio/webm",
      requestId: "request",
    });
    expect(result.text).toBe("hello");
    expect(result.languages).toEqual(["en"]);
    expect(request?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(request?.headers.get("authorization")).toBe("Bearer test-openai-key");
    if (!request) throw new Error("transcription request missing");
    const form = await request.formData();
    expect(form.get("model")).toBe("gpt-transcribe");
    expect((form.get("file") as File).name).toBe("audio.webm");
  });

  test("does not retry another provider after a send begins", async () => {
    let sends = 0;
    const service = createTranscriptionService({
      settings: testSettings({
        voiceInputProviderOrder: "openai,azure-openai",
        voiceInputAzureEndpoint: "https://example.openai.azure.com",
        voiceInputAzureDeployment: "transcribe",
        voiceInputAzureApiKey: "azure-key",
      }),
      db: {} as never,
      fetch: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
    });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "request",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(sends).toBe(1);
  });

  test("rejects unsupported MIME and oversized audio before sending", async () => {
    let sends = 0;
    const service = createTranscriptionService({
      settings: testSettings({
        voiceInputProviderOrder: "openai",
        voiceInputMaxSizeBytes: 2,
      }),
      db: {} as never,
      fetch: async () => {
        sends += 1;
        return Response.json({ text: "unexpected" });
      },
    });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/unsupported",
        requestId: "request",
      }),
    ).rejects.toMatchObject({ code: "not_supported" });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "request",
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(sends).toBe(0);
  });

  test("propagates an aborted request to the provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createTranscriptionService({
      settings: testSettings({ voiceInputProviderOrder: "openai" }),
      db: {} as never,
      fetch: async (_input, init) => {
        expect(init?.signal?.aborted).toBe(true);
        throw new DOMException("Aborted", "AbortError");
      },
    });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        signal: controller.signal,
        requestId: "request",
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  test("prefers Codex when subscription is attached even if OpenAI is configured", async () => {
    const accounts = spyOn(dbModule, "listCodexAccountStatuses").mockResolvedValue([
      {
        id: "cred-1",
        isActive: true,
        status: "active",
      },
    ] as never);
    const resolver = spyOn(dbModule, "buildCodexTokenResolver").mockReturnValue({
      getToken: async () => ({
        accessToken: "access",
        chatgptAccountId: "acct",
      }),
      refresh: async () => ({
        accessToken: "access",
        chatgptAccountId: "acct",
      }),
    } as never);
    try {
      let url: string | undefined;
      const service = createTranscriptionService({
        settings: testSettings({
          codexSubscriptionEnabled: true,
          voiceInputProviderOrder: "codex-subscription,openai,azure-openai",
        }),
        db: {} as never,
        codexFetch: async (input) => {
          url = String(input);
          return Response.json({ text: "from-codex", language: "en" });
        },
        fetch: async () => Response.json({ text: "from-openai", language: "en" }),
      });
      const result = await service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "request",
      });
      expect(result.text).toBe("from-codex");
      expect(result.providerId).toBe("codex-subscription");
      expect(url).toContain("/backend-api/transcribe");
    } finally {
      accounts.mockRestore();
      resolver.mockRestore();
    }
  });

  test("falls through to OpenAI when Codex is not attached to the workspace", async () => {
    const accounts = spyOn(dbModule, "listCodexAccountStatuses").mockResolvedValue([]);
    try {
      let openaiSends = 0;
      const service = createTranscriptionService({
        settings: testSettings({
          codexSubscriptionEnabled: true,
          voiceInputProviderOrder: "codex-subscription,openai,azure-openai",
        }),
        db: {} as never,
        codexFetch: async () => {
          throw new Error("codex should not be selected");
        },
        fetch: async () => {
          openaiSends += 1;
          return Response.json({ text: "from-openai", language: "en" });
        },
      });
      const result = await service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "request",
      });
      expect(result.text).toBe("from-openai");
      expect(result.providerId).toBe("openai");
      expect(openaiSends).toBe(1);
    } finally {
      accounts.mockRestore();
    }
  });
});
