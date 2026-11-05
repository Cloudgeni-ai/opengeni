import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_MODEL,
  CODEX_REALTIME_VERSION,
  CodexRealtimeError,
  createCodexRealtimeCall,
  fetchCodexRealtimeProviderConfig,
  selectCodexCredentialId,
} from "../src";

const auth = {
  accessToken: "server-only-token",
  chatgptAccountId: "acct_bound",
  isFedramp: true,
  clientVersion: "0.145.0",
};
const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const answer = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function providerResponse(body: BodyInit | null = answer, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("location")) headers.set("location", "/v1/live/rtc_test_call");
  return new Response(body, { ...init, headers });
}

describe("native Codex subscription realtime call", () => {
  test("encodes the exact V3 backend request with server-only account binding", async () => {
    let captured: Request | null = null;
    const result = await createCodexRealtimeCall(
      auth,
      {
        sdp: offer,
        version: "v3",
        sessionId: "11111111-1111-4111-8111-111111111111",
        instructions: "Help with the current Opengeni session.",
        initialItems: [
          { role: "developer", text: "Use the ordinary session context." },
          { role: "user", text: "What did we decide?" },
          { role: "assistant", text: "We decided to continue." },
        ],
        voice: "juniper",
      },
      async (input, init) => {
        captured = new Request(input, init);
        return providerResponse();
      },
    );

    expect(captured).not.toBeNull();
    const request = captured!;
    expect(request.url).toBe(
      "https://chatgpt.com/backend-api/wham/realtime/calls?intent=quicksilver&architecture=avas",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer server-only-token");
    expect(request.headers.get("chatgpt-account-id")).toBe("acct_bound");
    expect(request.headers.get("originator")).toBe("codex_cli_rs");
    expect(request.headers.get("user-agent")).toBe("codex_cli_rs/0.145.0");
    expect(request.headers.get("version")).toBe("0.145.0");
    expect(request.headers.get("x-openai-fedramp")).toBe("true");
    expect(request.headers.get("openai-alpha")).toBe("quicksilver=v2");
    expect(request.headers.get("session-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(request.headers.get("thread-id")).toBe("11111111-1111-4111-8111-111111111111");
    const voiceSessionId = request.headers.get("voice-session-id");
    expect(voiceSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({
      sdp: offer,
      session: {
        instructions: "Help with the current Opengeni session.",
        audio: { output: { voice: "juniper" } },
        delegation: { type: "client" },
        model: "gpt-live-1.1-codex",
        initial_items: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Use the ordinary session context." }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "What did we decide?" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "We decided to continue." }],
          },
        ],
        voice_session_id: voiceSessionId,
      },
    });
    expect(result).toEqual({
      sdp: answer,
      version: "v3",
      model: CODEX_REALTIME_MODEL,
    });
    expect(JSON.stringify(result)).not.toContain("server-only-token");
    expect(JSON.stringify(result)).not.toContain("acct_bound");
  });

  test("uses the upstream V3 default voice and omits an absent account header", async () => {
    let captured: Request | null = null;
    await createCodexRealtimeCall(
      { ...auth, chatgptAccountId: null, isFedramp: false },
      {
        sdp: offer,
        version: CODEX_REALTIME_VERSION,
        sessionId: "session-safe",
      },
      async (input, init) => {
        captured = new Request(input, init);
        return providerResponse();
      },
    );
    expect(captured!.headers.has("chatgpt-account-id")).toBe(false);
    expect(captured!.headers.has("x-openai-fedramp")).toBe(false);
    expect((await captured!.json()).session.audio.output.voice).toBe("cove");
  });

  test("rejects non-V3 versions and non-audio SDP before any provider call", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return providerResponse();
    };
    await expect(
      createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v2" as "v3", sessionId: "session-safe" },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "incompatible" });
    await expect(
      createCodexRealtimeCall(
        auth,
        {
          sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
          version: "v3",
          sessionId: "session-safe",
        },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(0);
  });

  test("rejects provider-bootstrap history outside the pinned V3 limits", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return providerResponse();
    };
    await expect(
      createCodexRealtimeCall(
        auth,
        {
          sdp: offer,
          version: "v3",
          sessionId: "session-safe",
          initialItems: Array.from({ length: 129 }, () => ({
            role: "user",
            text: "x",
          })),
        },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      createCodexRealtimeCall(
        auth,
        {
          sdp: offer,
          version: "v3",
          sessionId: "session-safe",
          initialItems: [{ role: "assistant", text: "x".repeat(32_769) }],
        },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(0);
  });

  test("requires an audio SDP answer and a compatible Location without exposing either body", async () => {
    await expect(
      createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v3", sessionId: "session-safe" },
        async () => providerResponse("not-sdp"),
      ),
    ).rejects.toMatchObject({ code: "invalid_response", providerStatus: 200 });
    await expect(
      createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v3", sessionId: "session-safe" },
        async () =>
          new Response(answer, {
            status: 200,
            headers: { location: "/v1/live/not-a-call" },
          }),
      ),
    ).rejects.toMatchObject({ code: "invalid_response", providerStatus: 200 });
  });

  test("maps an invalid UTF-8 SDP answer to a safe invalid-response error", async () => {
    await expect(
      createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v3", sessionId: "session-safe" },
        async () =>
          providerResponse(
            new Uint8Array([
              0x76, 0x3d, 0x30, 0x0a, 0x6d, 0x3d, 0x61, 0x75, 0x64, 0x69, 0x6f, 0xff,
            ]),
          ),
      ),
    ).rejects.toMatchObject({ code: "invalid_response", providerStatus: 200 });
  });

  test.each([
    [401, "authentication"],
    [403, "entitlement"],
    [404, "incompatible"],
    [429, "rate_limited"],
    [500, "provider"],
  ] as const)(
    "maps provider status %s and keeps only its error identifiers",
    async (status, code) => {
      const promise = createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v3", sessionId: "session-safe" },
        async () =>
          Response.json(
            {
              error: {
                code: "model_not_found",
                type: "invalid_request_error",
                param: "session.model",
                message: "provider-secret-body quoting the instructions",
              },
            },
            { status },
          ),
        {
          providerConfig: {
            architecture: "avas",
            model: "gpt-live-1-codex",
            version: "v3",
            source: "remote",
            advertisedVersion: "v3",
          },
        },
      );
      await expect(promise).rejects.toMatchObject({
        code,
        providerStatus: status,
        diagnostics: {
          stage: "call",
          providerErrorCode: "model_not_found",
          providerErrorType: "invalid_request_error",
          providerErrorParam: "session.model",
          configSource: "remote",
          advertisedVersion: "v3",
          providerModel: "gpt-live-1-codex",
          providerArchitecture: "avas",
        },
      });
      try {
        await promise;
      } catch (error) {
        expect(error).toBeInstanceOf(CodexRealtimeError);
        expect(String((error as Error).message)).not.toContain("provider-secret-body");
        expect(JSON.stringify((error as CodexRealtimeError).diagnostics)).not.toContain(
          "provider-secret-body",
        );
      }
    },
  );

  test("keeps a short provider detail but drops free text and oversized bodies", async () => {
    const call = (response: Response) =>
      createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v3", sessionId: "session-safe" },
        async () => response,
      );
    await expect(
      call(Response.json({ detail: "Not Found" }, { status: 404 })),
    ).rejects.toMatchObject({
      code: "incompatible",
      providerStatus: 404,
      diagnostics: { stage: "call", providerErrorCode: "Not Found", configSource: "fallback" },
    });
    const freeText = await call(
      Response.json({ detail: "Your instructions 'say hello' are invalid" }, { status: 400 }),
    ).then(
      () => {
        throw new Error("expected a provider failure");
      },
      (error: unknown) => error as CodexRealtimeError,
    );
    expect(freeText.diagnostics.providerErrorCode).toBeUndefined();
    let cancelled = false;
    const oversized = await call(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(17 * 1024)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      ),
    ).then(
      () => {
        throw new Error("expected a provider failure");
      },
      (error: unknown) => error as CodexRealtimeError,
    );
    expect(oversized).toMatchObject({ code: "provider", providerStatus: 500 });
    expect(oversized.diagnostics.providerErrorCode).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  test("forwards cancellation to the one provider request and never falls back", async () => {
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const abort = new AbortController();
    const pending = createCodexRealtimeCall(
      auth,
      { sdp: offer, version: "v3", sessionId: "session-safe" },
      async (_input, init) => {
        calls += 1;
        receivedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
      { signal: abort.signal },
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(receivedSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  test("does not call the provider when already cancelled", async () => {
    let calls = 0;
    const abort = new AbortController();
    abort.abort();
    await expect(
      createCodexRealtimeCall(
        auth,
        { sdp: offer, version: "v3", sessionId: "session-safe" },
        async () => {
          calls += 1;
          return providerResponse();
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });

  test("bounds a fetch that ignores AbortSignal and does not replay it", async () => {
    let calls = 0;
    const pending = createCodexRealtimeCall(
      auth,
      { sdp: offer, version: "v3", sessionId: "session-safe" },
      async () => {
        calls += 1;
        return await new Promise<Response>(() => {});
      },
      { timeoutMs: 5 },
    );
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(1);
  });
});

describe("Codex realtime remote configuration", () => {
  test("resolves the current V3 model and architecture from authenticated Statsig", async () => {
    let captured: Request | null = null;
    const config = await fetchCodexRealtimeProviderConfig(auth, async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        statsigPayload: JSON.stringify({
          dynamic_configs: {
            "3566525122": {
              value: {
                architecture: "avas-next",
                model: "gpt-live-1-codex",
                version: "v3",
              },
            },
          },
        }),
      });
    });

    expect(captured!.url).toBe("https://chatgpt.com/backend-api/wham/statsig/bootstrap");
    expect(captured!.headers.get("authorization")).toBe("Bearer server-only-token");
    expect(captured!.headers.get("chatgpt-account-id")).toBe("acct_bound");
    expect(config).toEqual({
      architecture: "avas-next",
      model: "gpt-live-1-codex",
      version: "v3",
      source: "remote",
      advertisedVersion: "v3",
    });
  });

  test.each(["v2", "v4"])(
    "keeps the pinned V3 parameters when the remote configuration advertises %s",
    async (advertised) => {
      // The advertised version is the first-party desktop client's preference;
      // its model and architecture are not V3 values, so they are never used,
      // and the call is not refused either (the Codex CLI speaks V3 without it).
      expect(
        await fetchCodexRealtimeProviderConfig(auth, async () =>
          Response.json({
            statsigPayload: JSON.stringify({
              dynamic_configs: {
                "3566525122": {
                  value: { architecture: "other", model: "other-model", version: advertised },
                },
              },
            }),
          }),
        ),
      ).toEqual({
        architecture: "avas",
        model: "gpt-live-1.1-codex",
        version: "v3",
        source: "fallback",
        advertisedVersion: advertised,
      });
    },
  );

  test("uses the verified V3 fallback for transient or malformed config responses", async () => {
    expect(
      await fetchCodexRealtimeProviderConfig(
        auth,
        async () => new Response("unavailable", { status: 503 }),
      ),
    ).toEqual({
      architecture: "avas",
      model: "gpt-live-1.1-codex",
      version: "v3",
      source: "fallback",
    });
    expect(
      await fetchCodexRealtimeProviderConfig(auth, async () => Response.json({ nope: true })),
    ).toEqual({
      architecture: "avas",
      model: "gpt-live-1.1-codex",
      version: "v3",
      source: "fallback",
    });
  });

  test("preserves an authentication rejection for the broker's one safe refresh", async () => {
    await expect(
      fetchCodexRealtimeProviderConfig(auth, async () => new Response(null, { status: 401 })),
    ).rejects.toMatchObject({
      code: "authentication",
      providerStatus: 401,
      diagnostics: { stage: "config" },
    });
  });
});

describe("Codex direct-call account selection", () => {
  test("uses a connected session pin, otherwise the connected active account", () => {
    expect(
      selectCodexCredentialId({
        sessionPinnedCredentialId: "pin",
        activeCredentialId: "active",
        connectedIds: new Set(["pin", "active"]),
      }),
    ).toBe("pin");
    expect(
      selectCodexCredentialId({
        sessionPinnedCredentialId: "disconnected-pin",
        activeCredentialId: "active",
        connectedIds: new Set(["active"]),
      }),
    ).toBe("active");
    expect(
      selectCodexCredentialId({
        sessionPinnedCredentialId: "pin",
        activeCredentialId: "active",
        connectedIds: new Set(),
      }),
    ).toBeNull();
  });
});
