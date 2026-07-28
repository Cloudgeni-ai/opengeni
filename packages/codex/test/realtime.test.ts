import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_MODEL,
  CODEX_REALTIME_VERSION,
  CodexRealtimeError,
  createCodexRealtimeCall,
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
        instructions: "Help with the current OpenGeni session.",
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
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
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
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({
      sdp: offer,
      session: {
        instructions: "Help with the current OpenGeni session.",
        audio: { output: { voice: "juniper" } },
        delegation: { type: "client" },
        model: "gpt-live-1-boulder-alpha",
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
  ] as const)("maps provider status %s and discards its body", async (status, code) => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const promise = createCodexRealtimeCall(
      auth,
      { sdp: offer, version: "v3", sessionId: "session-safe" },
      async () => new Response(body, { status }),
    );
    await expect(promise).rejects.toMatchObject({
      code,
      providerStatus: status,
    });
    expect(cancelled).toBe(true);
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(CodexRealtimeError);
      expect(String((error as Error).message)).not.toContain("provider-secret-body");
    }
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
