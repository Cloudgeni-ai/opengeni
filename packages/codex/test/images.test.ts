import { describe, expect, test } from "bun:test";
import {
  CODEX_RESPONSES_BASE,
  CodexImageApiError,
  generateCodexSubscriptionImage,
  type CodexTokenSnapshot,
} from "../src";

const token = (accessToken: string): CodexTokenSnapshot => ({
  accessToken,
  chatgptAccountId: "account-1",
  isFedramp: false,
});

describe("generateCodexSubscriptionImage", () => {
  test("uses the subscription Images endpoint and exact Codex request shape", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const result = await generateCodexSubscriptionImage({
      prompt: "a blue sphere",
      turnId: "turn-1",
      context: {
        clientVersion: "0.145.0",
        getToken: async () => token("access-1"),
        refresh: async () => token("access-2"),
      },
      fetch: async (input, init) => {
        captured = { url: String(input), init };
        return Response.json({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] });
      },
    });

    expect(result).toEqual({
      bytes: new TextEncoder().encode("image"),
      declaredMediaType: "image/png",
    });
    expect(captured?.url).toBe(`${CODEX_RESPONSES_BASE}/images/generations`);
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.redirect).toBe("error");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
    expect(headers.get("x-codex-image-turn-id")).toBe("turn-1");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      prompt: "a blue sphere",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    });
  });

  test("refreshes only after a definitive 401", async () => {
    const authorizations: string[] = [];
    let refreshes = 0;
    const result = await generateCodexSubscriptionImage({
      prompt: "a blue sphere",
      turnId: "turn-1",
      context: {
        clientVersion: "0.145.0",
        getToken: async () => token("stale"),
        refresh: async () => {
          refreshes += 1;
          return token("fresh");
        },
      },
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        return authorizations.length === 1
          ? Response.json({ error: { message: "expired" } }, { status: 401 })
          : Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
      },
    });
    expect(result.bytes).toEqual(new TextEncoder().encode("image"));
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("does not retry ambiguous provider failures", async () => {
    let calls = 0;
    await expect(
      generateCodexSubscriptionImage({
        prompt: "a blue sphere",
        turnId: "turn-1",
        context: {
          clientVersion: "0.145.0",
          getToken: async () => token("access"),
          refresh: async () => token("fresh"),
        },
        fetch: async () => {
          calls += 1;
          return Response.json({ error: { message: "busy" } }, { status: 503 });
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 503,
      } satisfies Partial<CodexImageApiError>),
    );
    expect(calls).toBe(1);
  });

  test("rejects oversized declared responses before reading the body", async () => {
    await expect(
      generateCodexSubscriptionImage({
        prompt: "a blue sphere",
        turnId: "turn-1",
        context: {
          clientVersion: "0.145.0",
          getToken: async () => token("access"),
          refresh: async () => token("fresh"),
        },
        fetch: async () =>
          new Response("{}", {
            headers: { "content-length": String(91 * 1024 * 1024) },
          }),
      }),
    ).rejects.toThrow("response byte limit");
  });

  test("decodes across arbitrary stream boundaries without retaining the JSON/base64 envelope", async () => {
    const json = JSON.stringify({
      note: "b64_json",
      data: [{ b64_json: "aW1hZ2U=" }],
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of new TextEncoder().encode(json)) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    });
    const result = await generateCodexSubscriptionImage({
      prompt: "a blue sphere",
      turnId: "turn-1",
      context: {
        clientVersion: "0.145.0",
        getToken: async () => token("access"),
        refresh: async () => token("fresh"),
      },
      fetch: async () => new Response(stream),
    });
    expect(result.bytes).toEqual(new TextEncoder().encode("image"));
  });

  test("rejects non-canonical streamed base64", async () => {
    await expect(
      generateCodexSubscriptionImage({
        prompt: "a blue sphere",
        turnId: "turn-1",
        context: {
          clientVersion: "0.145.0",
          getToken: async () => token("access"),
          refresh: async () => token("fresh"),
        },
        fetch: async () => Response.json({ data: [{ b64_json: "AB==" }] }),
      }),
    ).rejects.toThrow("non-canonical");
  });
});
