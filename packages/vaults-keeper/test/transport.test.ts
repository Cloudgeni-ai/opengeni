import { describe, expect, test } from "bun:test";
import { VaultProviderError } from "@opengeni/vaults";
import { createKeeperFetchTransport, createKeeperFileFetcher, type KeeperFetch } from "../src/sdk";

const KEY = { publicKeyId: 7, encryptedKey: new Uint8Array([1, 2, 3]) };
const PAYLOAD = { payload: new Uint8Array([4, 5]), signature: new Uint8Array([6]) };
const URL_ = "https://keepersecurity.com/api/rest/sm/v1/get_secret";

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: KeeperFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("injected fetch (the server's DNS-pinned fetch)", () => {
  test("the KSM transport sends the SDK request with no redirects and the caller's signal", async () => {
    const controller = new AbortController();
    const { fetch, calls } = recordingFetch(
      () => new Response(new Uint8Array([9, 9]), { status: 200 }),
    );
    const query = createKeeperFetchTransport({ fetch, signal: controller.signal });
    const result = await query(URL_, KEY as never, PAYLOAD as never, false, 1_000);
    expect(result.statusCode).toBe(200);
    expect([...result.data]).toEqual([9, 9]);
    const { init } = calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(headers.PublicKeyId).toBe("7");
    expect(headers.Authorization).toBe(`Signature ${Buffer.from([6]).toString("base64")}`);
    expect(init.signal!.aborted).toBe(false);
    controller.abort();
    expect(init.signal!.aborted).toBe(true);
  });

  test("redirect answers (from a manual-redirect fetch) are refused", async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } });
    const query = createKeeperFetchTransport({ fetch: recordingFetch(redirect).fetch });
    const error = await rejection(query(URL_, KEY as never, PAYLOAD as never, false, 1_000));
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_unavailable");

    const files = createKeeperFileFetcher(recordingFetch(redirect).fetch);
    const fileError = await rejection(
      files("https://files.keepersecurity.com/x", { maxBytes: 10, timeoutMs: 1_000 }),
    );
    expect((fileError as VaultProviderError).code).toBe("provider_unavailable");
  });

  test("file downloads are HTTPS only, bounded and cancellable", async () => {
    const big = recordingFetch(() => new Response(new Uint8Array(64), { status: 200 }));
    const files = createKeeperFileFetcher(big.fetch);
    expect(
      (
        (await rejection(
          files("http://files.example.test/x", { maxBytes: 10, timeoutMs: 1_000 }),
        )) as VaultProviderError
      ).code,
    ).toBe("provider_unavailable");
    expect(big.calls).toHaveLength(0);
    const controller = new AbortController();
    expect(
      (
        (await rejection(
          files("https://files.example.test/x", {
            maxBytes: 10,
            timeoutMs: 1_000,
            signal: controller.signal,
          }),
        )) as VaultProviderError
      ).code,
    ).toBe("provider_unavailable");
    controller.abort();
    expect(big.calls[0]!.init.signal!.aborted).toBe(true);
  });
});
