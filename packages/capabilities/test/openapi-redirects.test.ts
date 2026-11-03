import { describe, expect, test } from "bun:test";
import { compileOpenApiRevision, directIntegrationTransport, invokeOpenApiOperation } from "../src";
import { MAX_INLINE_BINARY_BYTES } from "../src/http";
import { MAX_INTEGRATION_REDIRECTS } from "../src/openapi";

const authority = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  initiatingSubjectId: "user:1",
  connectionRef: "connection-1",
};

// A file API in the shape of Microsoft Graph: `/content` answers with a
// redirect to a pre-signed download URL on another host.
const revision = compileOpenApiRevision(
  {
    openapi: "3.0.3",
    info: { title: "Files", version: "1" },
    servers: [{ url: "https://api.example.com/v1/" }],
    paths: {
      "/items/{id}/content": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { operationId: "items.getContent", responses: { "200": { description: "File" } } },
        put: {
          operationId: "items.putContent",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "Saved" } },
        },
      },
    },
  },
  { definitionId: "files" },
);

type Seen = { url: string; method: string; headers: Record<string, string> };

function invoke(
  toolId: string,
  answer: (url: URL, call: number) => Response | Promise<Response>,
  args: Record<string, unknown> = { path: { id: "abc" } },
  extra: { maxResponseBytes?: number } = {},
) {
  const seen: Seen[] = [];
  const invocation = invokeOpenApiOperation(
    {
      ...extra,
      revision,
      authority,
      credentialResolver: {
        resolve: async () => ({
          audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
          placements: [
            { carrier: "header", name: "Authorization", prefix: "Bearer ", value: "secret" },
            { carrier: "query", name: "key", value: "query-secret" },
            { carrier: "cookie", name: "session", value: "cookie-secret" },
          ],
        }),
      },
      transport: directIntegrationTransport(async (input, init) => {
        const url = new URL(String(input));
        seen.push({
          url: url.toString(),
          method: init?.method ?? "GET",
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        expect(init?.redirect).toBe("manual");
        return answer(url, seen.length);
      }),
    },
    toolId,
    args,
  );
  return { invocation, seen };
}

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe("OpenAPI redirects", () => {
  test("a read follows its redirect to the download URL without any credential", async () => {
    const { invocation, seen } = invoke("items_getcontent", (url) =>
      url.hostname === "api.example.com"
        ? redirect("https://files.example.net/dl/abc?sig=signed&key=query-secret#frag")
        : new Response("runbook text", { headers: { "content-type": "text/plain" } }),
    );
    expect(await invocation).toEqual({
      ok: true,
      status: 200,
      contentType: "text/plain",
      data: "runbook text",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers.authorization).toBe("Bearer secret");
    expect(seen[1]).toEqual({
      url: "https://files.example.net/dl/abc?sig=signed",
      method: "GET",
      headers: { accept: "*/*" },
    });
    for (const header of Object.values(seen[1]!.headers)) expect(header).not.toContain("secret");
  });

  test("a relative Location resolves against the request and a chain is bounded", async () => {
    const relative = invoke("items_getcontent", (_url, call) =>
      call === 1 ? redirect("/v1/elsewhere/abc", 307) : Response.json({ id: "abc" }),
    );
    expect(await relative.invocation).toMatchObject({ ok: true, data: { id: "abc" } });
    expect(relative.seen[1]!.url).toBe("https://api.example.com/v1/elsewhere/abc");
    expect(relative.seen[1]!.headers.authorization).toBeUndefined();

    const endless = invoke("items_getcontent", (_url, call) =>
      redirect(`https://files.example.net/hop/${call}`),
    );
    await expect(endless.invocation).rejects.toMatchObject({
      code: "redirect_rejected",
      outcome: "failed",
      status: 302,
    });
    expect(endless.seen).toHaveLength(MAX_INTEGRATION_REDIRECTS + 1);
  });

  test("a redirect to plain http or without a Location is rejected as a recoverable failure", async () => {
    for (const answer of [
      () => redirect("http://files.example.net/dl/abc"),
      () => new Response(null, { status: 302 }),
      () => new Response(null, { status: 304 }),
    ]) {
      const { invocation, seen } = invoke("items_getcontent", answer);
      await expect(invocation).rejects.toMatchObject({
        code: "redirect_rejected",
        outcome: "failed",
      });
      expect(seen).toHaveLength(1);
    }
  });

  test("a mutation's redirect is never followed and its outcome stays unknown", async () => {
    const { invocation, seen } = invoke(
      "items_putcontent",
      () => redirect("https://files.example.net/dl/abc", 307),
      { path: { id: "abc" }, body: { text: "new" } },
    );
    await expect(invocation).rejects.toMatchObject({
      code: "redirect_rejected",
      outcome: "unknown",
      status: 307,
    });
    expect(seen).toHaveLength(1);
  });

  test("bytes that are not UTF-8 come back as base64; text and JSON are unchanged", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x81]);
    const binary = invoke(
      "items_getcontent",
      () => new Response(pdf, { headers: { "content-type": "application/pdf" } }),
    );
    expect(await binary.invocation).toEqual({
      ok: true,
      status: 200,
      contentType: "application/pdf",
      data: { encoding: "base64", base64: Buffer.from(pdf).toString("base64") },
    });
    const utf8 = invoke(
      "items_getcontent",
      () =>
        new Response("plain bytes", { headers: { "content-type": "application/octet-stream" } }),
    );
    expect(await utf8.invocation).toMatchObject({ data: "plain bytes" });
  });

  test("an Office file is binary even though its type names xml", async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0xff, 0x8c]);
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const { invocation } = invoke(
      "items_getcontent",
      () => new Response(docx, { headers: { "content-type": contentType } }),
    );
    expect(await invocation).toMatchObject({
      ok: true,
      contentType,
      data: { encoding: "base64", base64: Buffer.from(docx).toString("base64") },
    });
    const xml = invoke(
      "items_getcontent",
      () =>
        new Response(new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e]), {
          headers: { "content-type": "application/atom+xml" },
        }),
    );
    expect(await xml.invocation).toMatchObject({ data: "<a>\uFFFD</a>" });
  });

  test("binary past the inline limit reports its size instead of its bytes", async () => {
    const large = new Uint8Array(MAX_INLINE_BINARY_BYTES + 1).fill(0xff);
    const { invocation } = invoke(
      "items_getcontent",
      () => new Response(large, { headers: { "content-type": "image/png" } }),
    );
    expect(await invocation).toMatchObject({
      ok: true,
      data: { encoding: "omitted", message: expect.stringContaining(String(large.byteLength)) },
    });
  });

  test("a body over the response limit is a recoverable response_too_large failure", async () => {
    const { invocation } = invoke(
      "items_getcontent",
      () => new Response("x".repeat(64), { headers: { "content-type": "text/plain" } }),
      undefined,
      { maxResponseBytes: 16 },
    );
    await expect(invocation).rejects.toMatchObject({
      code: "response_too_large",
      outcome: "failed",
      retryable: false,
      status: 200,
    });
  });

  test("a redirect target's 401 is the provider's result, not a lost authorization", async () => {
    const { invocation } = invoke("items_getcontent", (url) =>
      url.hostname === "api.example.com"
        ? redirect("https://files.example.net/dl/abc?sig=expired")
        : Response.json({ error: "expired link" }, { status: 401 }),
    );
    expect(await invocation).toMatchObject({
      ok: false,
      status: 401,
      data: { error: "expired link" },
    });
  });

  test("a signed query without a credential name is forwarded byte for byte", async () => {
    const signed = "https://files.example.net/dl/abc?sig=a%20b&exp=10:00";
    const { invocation, seen } = invoke("items_getcontent", (url) =>
      url.hostname === "api.example.com" ? redirect(signed) : new Response("ok"),
    );
    await invocation;
    expect(seen[1]!.url).toBe(new URL(signed).toString());
    expect(seen[1]!.url).toContain("sig=a%20b&exp=10:00");
  });

  test("a redirect destination that cannot be reached is a recoverable redirect_failed", async () => {
    const { invocation } = invoke("items_getcontent", (url) => {
      if (url.hostname === "api.example.com") return redirect("https://files.example.net/dl/abc");
      throw new Error("destination blocked by network policy");
    });
    await expect(invocation).rejects.toMatchObject({
      code: "redirect_failed",
      outcome: "not_started",
      message: expect.stringContaining("redirect"),
    });
  });
});
