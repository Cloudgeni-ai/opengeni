import { describe, expect, spyOn, test } from "bun:test";
import * as dbModule from "@opengeni/db";
import { TranscriptionServiceError } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import {
  createTranscriptionService,
  orderedProviders,
  remainingTranscriptionProviderRequestMilliseconds,
} from "../src/transcription/service";

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
    expect(request?.headers.get("x-opengeni-request-id")).toBe("request");
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

  test("owns a shorter provider deadline and classifies its abort as retryable timeout", async () => {
    let providerSignal: AbortSignal | undefined;
    const service = createTranscriptionService({
      settings: testSettings({ voiceInputProviderOrder: "openai" }),
      db: {} as never,
      providerRequestTimeoutMilliseconds: 5,
      fetch: async (_input, init) => {
        providerSignal = init?.signal;
        await new Promise<never>((_resolve, reject) => {
          providerSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "deadline-request",
      }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(providerSignal?.aborted).toBe(true);
  });

  test("rejects a late provider completion after the server deadline", async () => {
    const service = createTranscriptionService({
      settings: testSettings({ voiceInputProviderOrder: "openai" }),
      db: {} as never,
      providerRequestTimeoutMilliseconds: 5,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return Response.json({ text: "late", language: "en" });
      },
    });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "late-request",
      }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  test("keeps the absolute deadline after delayed provider-start refresh and commit", async () => {
    const providerStartedAt = new Date("2026-08-05T00:00:00.000Z");
    const providerDeadlineAt = new Date(providerStartedAt.getTime() + 10 * 60_000);
    const remainingByRefreshDelay = [0, 4, 5, 6].map((delayMinutes) =>
      remainingTranscriptionProviderRequestMilliseconds(
        providerDeadlineAt,
        new Date(providerStartedAt.getTime() + delayMinutes * 60_000),
      ),
    );
    expect(remainingByRefreshDelay).toEqual([600_000, 360_000, 300_000, 240_000]);

    const service = createTranscriptionService({
      settings: testSettings({ voiceInputProviderOrder: "openai" }),
      db: {} as never,
      // A fresh full timeout would expire this deliberately slow provider;
      // the persisted deadline still has four minutes after a six-minute
      // refresh/commit delay.
      providerRequestTimeoutMilliseconds: 5,
      now: () => new Date(providerStartedAt.getTime() + 6 * 60_000),
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return Response.json({ text: "after refresh", language: "en" });
      },
    });
    const result = await service.transcribe({
      workspaceId: "workspace",
      accountId: "account",
      audio,
      mimeType: "audio/webm",
      requestId: "absolute-deadline-request",
      providerDeadlineAt,
    });
    expect(result.text).toBe("after refresh");
  });

  test("refuses provider invocation when refresh/commit returns after the absolute deadline", async () => {
    let sends = 0;
    const providerStartedAt = new Date("2026-08-05T00:00:00.000Z");
    const providerDeadlineAt = new Date(providerStartedAt.getTime() + 10 * 60_000);
    const service = createTranscriptionService({
      settings: testSettings({ voiceInputProviderOrder: "openai" }),
      db: {} as never,
      now: () => new Date(providerDeadlineAt.getTime() + 1),
      fetch: async () => {
        sends += 1;
        return Response.json({ text: "must not send" });
      },
    });
    await expect(
      service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "expired-absolute-deadline-request",
        providerDeadlineAt,
      }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(sends).toBe(0);
  });

  test.each([200, 429])(
    "SUB-FAIL-10 prefers Codex and never switches providers after its response %i",
    async (status) => {
      // An enabled cutover with a shared connection selects the core path.
      const disposition = spyOn(dbModule, "readCodexCutoverDisposition").mockResolvedValue("core");
      const candidates = spyOn(
        dbModule,
        "listSubscriptionCoreCodexOperationCandidates",
      ).mockResolvedValue([{ connectionId: "connection-1" }] as never);
      const acquired = spyOn(
        dbModule,
        "acquireSubscriptionCoreCodexOperationLease",
      ).mockResolvedValue({ kind: "acquired" } as never);
      const renewed = spyOn(dbModule, "renewSubscriptionCoreCodexOperationLease").mockResolvedValue(
        true as never,
      );
      const released = spyOn(
        dbModule,
        "releaseSubscriptionCoreCodexOperationLease",
      ).mockResolvedValue(true as never);
      const resolver = spyOn(
        dbModule,
        "buildSubscriptionCoreCodexConnectionTokenResolver",
      ).mockReturnValue({
        getToken: async () => ({
          accessToken: "access",
          chatgptAccountId: "acct",
        }),
        refresh: async () => ({
          accessToken: "access",
          chatgptAccountId: "acct",
        }),
      } as never);
      const operationFetch = spyOn(
        dbModule,
        "buildSubscriptionCoreCodexOperationFetch",
      ).mockImplementation(
        ((_db: unknown, _scope: unknown, _ref: unknown, _id: unknown, base: unknown) =>
          base) as never,
      );
      try {
        let url: string | undefined;
        let otherProviderCalls = 0;
        const service = createTranscriptionService({
          settings: testSettings({
            codexSubscriptionEnabled: true,
            voiceInputProviderOrder: "codex-subscription,openai,azure-openai",
          }),
          db: {} as never,
          codexFetch: async (input) => {
            url = String(input);
            return Response.json({ text: "from-codex", language: "en" }, { status });
          },
          fetch: async () => {
            otherProviderCalls++;
            return Response.json({ text: "from-openai", language: "en" });
          },
        });
        const pending = service.transcribe({
          workspaceId: "workspace",
          accountId: "account",
          audio,
          mimeType: "audio/webm",
          requestId: "request",
        });
        if (status === 200) {
          const result = await pending;
          expect(result.text).toBe("from-codex");
          expect(result.providerId).toBe("codex-subscription");
        } else await expect(pending).rejects.toMatchObject({ fallbackSafe: false });
        expect(otherProviderCalls).toBe(0);
        expect(url).toContain("/backend-api/transcribe");
      } finally {
        for (const spy of [
          disposition,
          candidates,
          acquired,
          renewed,
          released,
          resolver,
          operationFetch,
        ])
          spy.mockRestore();
      }
    },
  );

  test("a credit refusal before any audio is sent falls back to the connected Codex subscription", async () => {
    const disposition = spyOn(dbModule, "readCodexCutoverDisposition").mockResolvedValue("core");
    const candidates = spyOn(
      dbModule,
      "listSubscriptionCoreCodexOperationCandidates",
    ).mockResolvedValue([{ connectionId: "connection-1" }] as never);
    const acquired = spyOn(
      dbModule,
      "acquireSubscriptionCoreCodexOperationLease",
    ).mockResolvedValue({ kind: "acquired" } as never);
    const renewed = spyOn(dbModule, "renewSubscriptionCoreCodexOperationLease").mockResolvedValue(
      true as never,
    );
    const released = spyOn(
      dbModule,
      "releaseSubscriptionCoreCodexOperationLease",
    ).mockResolvedValue(true as never);
    const resolver = spyOn(
      dbModule,
      "buildSubscriptionCoreCodexConnectionTokenResolver",
    ).mockReturnValue({
      getToken: async () => ({ accessToken: "access", chatgptAccountId: "acct" }),
      refresh: async () => ({ accessToken: "access", chatgptAccountId: "acct" }),
    } as never);
    const operationFetch = spyOn(
      dbModule,
      "buildSubscriptionCoreCodexOperationFetch",
    ).mockImplementation(
      ((_db: unknown, _scope: unknown, _ref: unknown, _id: unknown, base: unknown) =>
        base) as never,
    );
    try {
      let openAiSends = 0;
      let admits = 0;
      const service = createTranscriptionService({
        settings: testSettings({
          billingMode: "stripe",
          codexSubscriptionEnabled: true,
          // The deployment-paid provider comes first, as a workspace may prefer it.
          voiceInputProviderOrder: "openai,codex-subscription",
        }),
        db: {} as never,
        normalizeAudio: async () => ({ bytes: audio, durationSeconds: 1 }),
        billing: {
          admit: async () => {
            admits++;
            // Opengeni credits are turned off in this workspace.
            throw new TranscriptionServiceError({
              code: "policy_blocked",
              status: 403,
              fallbackSafe: true,
              message: "Opengeni credits are turned off in this workspace.",
            });
          },
          settle: async () => {
            throw new Error("a subscription transcript is never settled in credits");
          },
        },
        codexFetch: async () => Response.json({ text: "from-codex", language: "en" }),
        fetch: async () => {
          openAiSends++;
          return Response.json({ text: "from-openai", language: "en" });
        },
      });
      const result = await service.transcribe({
        workspaceId: "workspace",
        accountId: "account",
        audio,
        mimeType: "audio/webm",
        requestId: "request",
        billing: { sourceId: "unit", attribution: { kind: "service" } },
      });
      expect(result.providerId).toBe("codex-subscription");
      expect(result.text).toBe("from-codex");
      expect(admits).toBe(1);
      expect(openAiSends).toBe(0);
      // An exact provider choice is never swapped for another one.
      await expect(
        service.transcribe({
          workspaceId: "workspace",
          accountId: "account",
          audio,
          mimeType: "audio/webm",
          requestId: "request-exact",
          providerId: "openai",
          billing: { sourceId: "unit-exact", attribution: { kind: "service" } },
        }),
      ).rejects.toMatchObject({ code: "policy_blocked" });
      expect(openAiSends).toBe(0);
    } finally {
      for (const spy of [
        disposition,
        candidates,
        acquired,
        renewed,
        released,
        resolver,
        operationFetch,
      ])
        spy.mockRestore();
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

describe("transcription preference and fallback", () => {
  const settings = testSettings({
    voiceInputProviderOrder: "openai,azure-openai",
    voiceInputAzureEndpoint: "https://azure.example",
    voiceInputAzureDeployment: "stt",
    voiceInputAzureApiKey: "test-azure",
  });
  const request = {
    workspaceId: "workspace",
    accountId: "account",
    subjectId: "user:test",
    audio,
    mimeType: "audio/webm",
    requestId: "preference-test",
  };
  test("prefers the workspace choice over deployment order", async () => {
    const service = createTranscriptionService({
      settings,
      db: {} as never,
      fetch: async () => Response.json({ text: "ok" }),
    });
    expect(await service.selectProvider!({ ...request, preferredProvider: "azure-openai" })).toBe(
      "azure-openai",
    );
    expect(
      (await service.transcribe({ ...request, preferredProvider: "azure-openai" })).providerId,
    ).toBe("azure-openai");
    expect(
      await service.selectProvider!({
        ...request,
        preferredProvider: "codex-subscription",
        fallbackEnabled: false,
      }),
    ).toBeNull();
    expect(
      await service.selectProvider!({ ...request, preferredProvider: "codex-subscription" }),
    ).toBe("openai");
  });
  test("falls through an explicit auth rejection but honors disabled fallback and recording pins", async () => {
    let calls: string[] = [];
    const service = createTranscriptionService({
      settings,
      db: {} as never,
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).startsWith("https://api.openai.com")
          ? new Response(null, { status: 403 })
          : Response.json({ text: "recovered" });
      },
    });
    expect((await service.transcribe(request)).providerId).toBe("azure-openai");
    expect(calls).toHaveLength(2);
    for (const policy of [{ fallbackEnabled: false }, { providerId: "openai" }]) {
      calls = [];
      await expect(service.transcribe({ ...request, ...policy })).rejects.toMatchObject({
        fallbackSafe: true,
      });
      expect(calls).toHaveLength(1);
    }
  });
  test("advances A to B to C without cycling back to rejected providers", () => {
    const providers = ["openai", "azure-openai", "codex-subscription"].map(
      (id) =>
        ({
          id,
          supportsServerDeadline: true,
          available: () => true,
          transcribe: async () => ({ text: "", languages: [] }),
        }) as const,
    );
    expect(orderedProviders(providers, { afterProvider: "azure-openai" }).map((p) => p.id)).toEqual(
      ["codex-subscription"],
    );
    expect(orderedProviders(providers, { afterProvider: "codex-subscription" })).toEqual([]);
  });
});
