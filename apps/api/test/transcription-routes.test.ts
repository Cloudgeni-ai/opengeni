import { afterEach, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";

import { createApp } from "../src/app";

const SECRET = "transcription-route-delegation-secret";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000011";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000012";
const PLATFORM_KEY = "platform-key-must-never-leave-the-api";
const PROTOTYPE_PRIVACY = {
  retainAudio: false,
  retainTranscript: false,
  trainingAllowed: false,
} as const;

const poisonDb = new Proxy(
  {},
  {
    get() {
      throw new Error("database must not be touched for delegated transcription authorization");
    },
  },
);

function app(overrides: Parameters<typeof testSettings>[0] = {}) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      openaiProvider: "openai",
      openaiApiKey: PLATFORM_KEY,
      ...overrides,
    }),
    db: poisonDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

async function bearer(permissions: Permission[]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: "transcription-tester",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

async function mint(
  permissions: Permission[] | null,
  body: unknown = {
    sessionId: "dictation-1",
    language: "en",
    diarization: false,
    privacy: PROTOTYPE_PRIVACY,
  },
  settings: Parameters<typeof testSettings>[0] = {},
): Promise<Response> {
  return await app(settings).request(`/v1/workspaces/${WORKSPACE_ID}/transcription/client-secret`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(permissions ? { authorization: await bearer(permissions) } : {}),
    },
    body: JSON.stringify(body),
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("transcription client-secret route", () => {
  test("rejects missing/wrong authorization before any provider or database touch", async () => {
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const missing = await mint(null);
    const wrongScope = await mint(["workspace:read"]);

    expect([401, 403]).toContain(missing.status);
    expect(wrongScope.status).toBe(403);
    expect(providerCalls).toBe(0);
  });

  test("mints an OpenAI transcription secret and returns only ephemeral fields", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          expires_at: 2_000_000_000,
          value: "ek_ephemeral_value",
          session: { id: "sess_provider_1", type: "transcription", expires_at: 2_000_000_100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const response = await mint(["sessions:control"]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      value: "ek_ephemeral_value",
      expiresAt: 2_000_000_000,
      providerSessionId: "sess_provider_1",
    });
    expect(JSON.stringify(body)).not.toContain(PLATFORM_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${PLATFORM_KEY}`,
    );
    expect(new Headers(calls[0]?.init?.headers).get("openai-safety-identifier")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "transcription",
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-4o-transcribe", language: "en" },
            turn_detection: {
              type: "server_vad",
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              threshold: 0.5,
            },
          },
        },
      },
    });
  });

  test("rejects Azure, custom OpenAI base URLs, missing keys, and unsupported diarization", async () => {
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const azure = await mint(["sessions:control"], {}, { openaiProvider: "azure" });
    const custom = await mint(
      ["sessions:control"],
      {},
      { openaiBaseUrl: "https://proxy.example.test/v1" },
    );
    const noKey = await mint(["sessions:control"], {}, { openaiApiKey: undefined });
    const diarization = await mint(["sessions:control"], {
      sessionId: "dictation-1",
      diarization: true,
      privacy: PROTOTYPE_PRIVACY,
    });

    expect(azure.status).toBe(409);
    expect(custom.status).toBe(409);
    expect(noKey.status).toBe(503);
    expect(diarization.status).toBe(422);
    expect(providerCalls).toBe(0);
  });

  test("rejects missing, retaining, training, region, and residency privacy requests", async () => {
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const request = (privacy?: Record<string, unknown>) => ({
      sessionId: "dictation-1",
      diarization: false,
      ...(privacy ? { privacy } : {}),
    });
    const responses = await Promise.all([
      mint(["sessions:control"], request()),
      mint(["sessions:control"], request({ ...PROTOTYPE_PRIVACY, retainAudio: true })),
      mint(["sessions:control"], request({ ...PROTOTYPE_PRIVACY, retainTranscript: true })),
      mint(["sessions:control"], request({ ...PROTOTYPE_PRIVACY, trainingAllowed: true })),
      mint(["sessions:control"], request({ ...PROTOTYPE_PRIVACY, region: "eu-west" })),
      mint(
        ["sessions:control"],
        request({ ...PROTOTYPE_PRIVACY, dataResidency: "European Union" }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([422, 422, 422, 422, 422, 422]);
    expect(providerCalls).toBe(0);
  });

  test("sanitizes provider failures and malformed provider responses", async () => {
    globalThis.fetch = (async () =>
      new Response(`provider leaked ${PLATFORM_KEY}`, { status: 401 })) as typeof fetch;
    const failed = await mint(["sessions:control"]);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(PLATFORM_KEY);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ value: PLATFORM_KEY }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const malformed = await mint(["sessions:control"]);
    expect(malformed.status).toBe(502);
    expect(await malformed.text()).not.toContain(PLATFORM_KEY);
  });
});
