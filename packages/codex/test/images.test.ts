import { describe, expect, test } from "bun:test";
import {
  CODEX_RESPONSES_BASE,
  CodexImageApiError,
  CodexImageRequestTimeoutError,
  generateCodexSubscriptionImage,
  type CodexTokenSnapshot,
  type CodexProviderRequestIdentity,
  type CodexProviderRequestSettlement,
} from "../src";

const token = (accessToken: string): CodexTokenSnapshot => ({
  accessToken,
  chatgptAccountId: "account-1",
  isFedramp: false,
});

describe("generateCodexSubscriptionImage", () => {
  test("physical image auth retries reserve separately and settle only full responses", async () => {
    const reservations: CodexProviderRequestIdentity[] = [];
    const settlements: CodexProviderRequestSettlement[] = [];
    const auth: string[] = [];
    await generateCodexSubscriptionImage({
      prompt: "fixture",
      turnId: "turn",
      context: {
        clientVersion: "test",
        nextRequestId: () => "image-request",
        getToken: async () => token("old"),
        refresh: async () => token("new"),
        beforeProviderDispatch: (value) => {
          reservations.push(value!);
        },
        onProviderRequestSettled: (value) => {
          settlements.push(value);
        },
      },
      fetch: async (_url, init) => {
        auth.push(new Headers(init?.headers).get("authorization")!);
        expect(reservations).toHaveLength(auth.length);
        return auth.length === 1
          ? Response.json({}, { status: 401 })
          : Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
      },
    });
    expect(reservations).toEqual([
      { requestId: "image-request", transportAttempt: 1 },
      { requestId: "image-request", transportAttempt: 2 },
    ]);
    expect(settlements.map((value) => value.outcome)).toEqual(["refused", "response_received"]);
    expect(auth).toEqual(["Bearer old", "Bearer new"]);
  });

  test("image body custody survives disconnect and settles only after EOF", async () => {
    let disconnected = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let dispatched!: () => void;
    const started = new Promise<void>((yes) => {
      dispatched = yes;
    });
    const outcomes: string[] = [];
    let fetches = 0;
    const context = {
      clientVersion: "test",
      getToken: async () => token("loaded"),
      refresh: async () => {
        throw new Error("source disconnected");
      },
      beforeProviderDispatch: () => {
        if (disconnected) throw new Error("source disconnected");
      },
      onProviderRequestSettled: (value: CodexProviderRequestSettlement) => {
        outcomes.push(value.outcome);
      },
    };
    const fetch: Parameters<typeof generateCodexSubscriptionImage>[0]["fetch"] = async () => {
      fetches++;
      const response = new Response(
        new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
      );
      dispatched();
      return response;
    };
    const pending = generateCodexSubscriptionImage({
      prompt: "fixture",
      turnId: "turn",
      context,
      fetch,
    });
    await started;
    disconnected = true;
    controller.enqueue(new TextEncoder().encode('{"data":[{"b64_json":"aW1hZ2U="}]}'));
    await Bun.sleep(1);
    expect(outcomes).toEqual([]);
    controller.close();
    expect((await pending).bytes).toEqual(new TextEncoder().encode("image"));
    expect(outcomes).toEqual(["response_received"]);
    await expect(
      generateCodexSubscriptionImage({ prompt: "fixture", turnId: "turn", context, fetch }),
    ).rejects.toThrow("source disconnected");
    expect(fetches).toBe(1);
  });

  test("ignored image abort remains unknown after a late complete body and is never retried", async () => {
    const outcomes: string[] = [];
    let resolve!: (value: Response) => void;
    let fetches = 0;
    await expect(
      generateCodexSubscriptionImage({
        prompt: "fixture",
        turnId: "turn",
        requestTimeoutMs: 10,
        context: {
          clientVersion: "test",
          getToken: async () => token("old"),
          refresh: async () => token("new"),
          onProviderRequestSettled: (value) => {
            outcomes.push(value.outcome);
          },
        },
        fetch: async () => {
          fetches++;
          return await new Promise<Response>((yes) => {
            resolve = yes;
          });
        },
      }),
    ).rejects.toBeInstanceOf(CodexImageRequestTimeoutError);
    resolve(Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }));
    await Bun.sleep(1);
    expect(outcomes).toEqual(["unknown"]);
    expect(fetches).toBe(1);
  });

  test("a decoded image field with a stalled trailing body times out as unknown", async () => {
    const outcomes: string[] = [];
    let fetches = 0;
    let cancellations = 0;
    await expect(
      generateCodexSubscriptionImage({
        prompt: "fixture",
        turnId: "turn",
        requestTimeoutMs: 10,
        context: {
          clientVersion: "test",
          getToken: async () => token("loaded"),
          refresh: async () => token("unused"),
          onProviderRequestSettled: (value) => {
            outcomes.push(value.outcome);
          },
        },
        fetch: async () => {
          fetches++;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":[{"b64_json":"aW1hZ2U="}]}'));
              },
              cancel() {
                cancellations++;
              },
            }),
          );
        },
      }),
    ).rejects.toBeInstanceOf(CodexImageRequestTimeoutError);
    await Bun.sleep(1);
    expect(outcomes).toEqual(["unknown"]);
    expect(fetches).toBe(1);
    expect(cancellations).toBe(1);
  });

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
      model: "gpt-image-2.5-sunburst",
      quality: "auto",
      size: "auto",
    });
  });

  test("uses the subscription edit endpoint with ordered reference images", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    await generateCodexSubscriptionImage({
      prompt: "Use the first image's subject and the second image's style",
      references: [
        { mediaType: "image/png", bytes: Uint8Array.from([1, 2, 3]) },
        { mediaType: "image/jpeg", bytes: Uint8Array.from([4, 5, 6]) },
      ],
      turnId: "turn-edit-1",
      context: {
        clientVersion: "0.145.0",
        getToken: async () => token("access-1"),
        refresh: async () => token("access-2"),
      },
      fetch: async (input, init) => {
        captured = { url: String(input), init };
        return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
      },
    });

    expect(captured?.url).toBe(`${CODEX_RESPONSES_BASE}/images/edits`);
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      images: [
        { image_url: "data:image/png;base64,AQID" },
        { image_url: "data:image/jpeg;base64,BAUG" },
      ],
      prompt: "Use the first image's subject and the second image's style",
      background: "auto",
      model: "gpt-image-2.5-sunburst",
      quality: "auto",
      size: "auto",
    });
  });

  test("refreshes only after a definitive 401", async () => {
    const authorizations: string[] = [];
    let refreshes = 0;
    let fences = 0;
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
        beforeProviderDispatch: () => {
          fences += 1;
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
    expect(fences).toBe(2);
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

  test("bounds the whole paid request without retrying a lost provider connection", async () => {
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
        requestTimeoutMs: 10,
        fetch: async (_input, init) => {
          calls += 1;
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        },
      }),
    ).rejects.toBeInstanceOf(CodexImageRequestTimeoutError);
    expect(calls).toBe(1);
  });

  test("bounds credential resolution inside the same absolute deadline", async () => {
    let calls = 0;
    await expect(
      generateCodexSubscriptionImage({
        prompt: "a blue sphere",
        turnId: "turn-1",
        context: {
          clientVersion: "0.145.0",
          getToken: async () => await new Promise<CodexTokenSnapshot>(() => undefined),
          refresh: async () => token("fresh"),
        },
        requestTimeoutMs: 10,
        fetch: async () => {
          calls += 1;
          return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
        },
      }),
    ).rejects.toBeInstanceOf(CodexImageRequestTimeoutError);
    expect(calls).toBe(0);
  });

  test("preserves caller cancellation instead of misreporting it as a timeout", async () => {
    const controller = new AbortController();
    const cancelled = new Error("turn cancelled");
    const operation = generateCodexSubscriptionImage({
      prompt: "a blue sphere",
      turnId: "turn-1",
      context: {
        clientVersion: "0.145.0",
        getToken: async () => token("access"),
        refresh: async () => token("fresh"),
      },
      abortSignal: controller.signal,
      requestTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        if (init?.signal?.aborted) throw init.signal.reason;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    controller.abort(cancelled);
    await expect(operation).rejects.toBe(cancelled);
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
