import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";

import { readLensWebhookBody } from "../src/routes/lens";

describe("Lens webhook ingress bounds", () => {
  test("preserves accepted raw bytes exactly", async () => {
    const raw = new TextEncoder().encode('{"message":"exact"}');
    const body = await readLensWebhookBody(
      new Request("https://opengeni.example/v1/webhooks/lens/a/b/c", {
        method: "POST",
        body: raw,
      }),
    );
    expect(body).toEqual(raw);
  });

  test("rejects declared and streamed bodies over 2 MiB", async () => {
    await expect(
      readLensWebhookBody(
        new Request("https://opengeni.example/v1/webhooks/lens/a/b/c", {
          method: "POST",
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
          body: "small",
        }),
      ),
    ).rejects.toMatchObject<Partial<HTTPException>>({ status: 413 });

    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    await expect(
      readLensWebhookBody(
        new Request("https://opengeni.example/v1/webhooks/lens/a/b/c", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(oversized.subarray(0, 1024 * 1024));
              controller.enqueue(oversized.subarray(1024 * 1024));
              controller.close();
            },
          }),
          // Required by Node-compatible Request implementations for streaming bodies.
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      ),
    ).rejects.toMatchObject<Partial<HTTPException>>({ status: 413 });
  });
});
