import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { siteGatewayCanonicalString, type SiteGatewaySignedFields } from "@opengeni/contracts";
import { signGatewayFields, signedApiRequest } from "../src/signing";
import { TEST_SECRET, verifyGatewaySignature } from "./helpers";

const fields: SiteGatewaySignedFields = {
  method: "post",
  pathWithQuery: "/v1/site-runtime/sessions?limit=5",
  timestamp: 1_760_000_000,
  bodySha256: createHash("sha256").update('{"a":1}').digest("hex"),
  host: "Team-4K9X.sites.test",
  session: "s".repeat(40),
  visitor: "v".repeat(22),
  clientIp: "203.0.113.7",
  human: "1",
};

describe("gateway request signing", () => {
  test("signs exactly siteGatewayCanonicalString with HMAC-SHA256 as v1=<base64url>", async () => {
    const expected = createHmac("sha256", TEST_SECRET)
      .update(siteGatewayCanonicalString(fields))
      .digest("base64url");
    expect(await signGatewayFields(TEST_SECRET, fields)).toBe(`v1=${expected}`);
  });

  test("a signed API request verifies on the API side and carries only gateway headers", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const forwarded = new Headers({ "content-type": "application/json" });
    const request = await signedApiRequest(
      { apiOrigin: "https://api.example.test", secret: TEST_SECRET },
      { host: "team-4k9x.sites.test", session: "", visitor: "abc", clientIp: "", human: false },
      { method: "post", suffix: "/sessions", search: "?x=1", body, headers: forwarded },
    );
    expect(request.url).toBe("https://api.example.test/v1/site-runtime/sessions?x=1");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-opengeni-site-host")).toBe("team-4k9x.sites.test");
    expect(request.headers.get("x-opengeni-site-visitor")).toBe("abc");
    expect(request.headers.has("x-opengeni-site-session")).toBe(false);
    expect(request.headers.has("x-opengeni-site-human")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
    const received = new Uint8Array(await request.arrayBuffer());
    expect(verifyGatewaySignature(TEST_SECRET, request, received)).toBe(true);
    // Any change to the signed material fails.
    expect(verifyGatewaySignature(TEST_SECRET, request, new TextEncoder().encode("{}"))).toBe(
      false,
    );
    expect(verifyGatewaySignature(`${TEST_SECRET}x`, request, received)).toBe(false);
    const tampered = new Headers(request.headers);
    tampered.set("x-opengeni-site-visitor", "someone-else");
    expect(
      verifyGatewaySignature(
        TEST_SECRET,
        { ...request, url: request.url, method: "POST", headers: tampered },
        received,
      ),
    ).toBe(false);
  });

  test("an empty body hashes the empty string and old timestamps are refused", async () => {
    const request = await signedApiRequest(
      { apiOrigin: "https://api.example.test", secret: TEST_SECRET },
      { host: "a-site.sites.test", session: "", visitor: "", clientIp: "", human: false },
      { method: "GET", suffix: "/host", now: Date.now() - 120_000 },
    );
    expect(verifyGatewaySignature(TEST_SECRET, request, new Uint8Array())).toBe(false);
    expect(
      verifyGatewaySignature(TEST_SECRET, request, new Uint8Array(), Date.now() - 120_000),
    ).toBe(true);
  });
});
