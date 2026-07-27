import { describe, expect, test } from "bun:test";
import {
  createSecretRedactor,
  redactSensitiveData,
  redactSensitiveText,
  redactSerializedJson,
} from "../src/secret-redaction";

const SYNTHETIC_LONG = "synthetic-known-value-123456";
const SYNTHETIC_SHORT = "known-value-123456";

describe("secret redaction boundary", () => {
  test("redacts exact known provenance longest-first without exposing unsafe names", () => {
    const redact = createSecretRedactor([
      { name: "LONG_TOKEN", value: SYNTHETIC_LONG },
      { name: "short token/../../", value: SYNTHETIC_SHORT },
    ]);

    expect(redact(`a ${SYNTHETIC_LONG} b ${SYNTHETIC_SHORT}`)).toBe(
      "a [redacted:LONG_TOKEN] b [redacted:SHORT_TOKEN]",
    );
  });

  test("redacts nested sensitive fields while retaining useful structure", () => {
    const cleaned = redactSensitiveData({
      status: 401,
      message: "request rejected by upstream",
      headers: {
        authorization: "Bearer synthetic-bearer-value-123456",
        "content-type": "application/json",
      },
      nested: {
        refreshToken: "synthetic-refresh-value-123456",
        endpoint: "https://api.example/v1/items",
      },
    });

    expect(cleaned).toEqual({
      status: 401,
      message: "request rejected by upstream",
      headers: {
        authorization: "[redacted]",
        "content-type": "application/json",
      },
      nested: {
        refreshToken: "[redacted]",
        endpoint: "https://api.example/v1/items",
      },
    });
  });

  test("preserves public token, signature, and ordinary protocol headers", () => {
    const value = {
      token: "page-2",
      signature: "sha256=public-digest",
      mediaType: "application/json",
      headers: {
        authorization: "Bearer synthetic-auth-value-123456",
        cookie: "session=synthetic-cookie-value-123456",
        "x-api-key": "synthetic-api-key-value-123456",
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "mcp-client/1.0",
        "x-page-token": "page-2",
        "x-signature": "sha256=public-digest",
      },
    };

    expect(redactSensitiveData(value)).toEqual({
      ...value,
      headers: {
        authorization: "[redacted]",
        cookie: "[redacted]",
        "x-api-key": "[redacted]",
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "mcp-client/1.0",
        "x-page-token": "page-2",
        "x-signature": "sha256=public-digest",
      },
    });
  });

  test("redacts registered secrets even under generic token and signature fields", () => {
    const knownSecrets = [
      { name: "PAGE_TOKEN_SECRET", value: "synthetic-page-token-123456" },
      { name: "PUBLIC_SIGNATURE_SECRET", value: "synthetic-signature-123456" },
    ];
    const value = {
      token: "synthetic-page-token-123456",
      signature: "synthetic-signature-123456",
    };

    expect(redactSensitiveData(value, knownSecrets)).toEqual({
      token: "[redacted:PAGE_TOKEN_SECRET]",
      signature: "[redacted:PUBLIC_SIGNATURE_SECRET]",
    });
  });

  test("redacts exact secrets in nested keys with deterministic collision suffixes", () => {
    const secret = "synthetic-key-secret-123456";
    const value: Record<string, unknown> = {
      [secret]: { nested: secret },
      "[redacted:KEY_SECRET]": "public marker-shaped key",
    };
    const cleaned = redactSensitiveData(value, [{ name: "KEY_SECRET", value: secret }]);

    expect(cleaned).toEqual({
      "[redacted:KEY_SECRET]": { nested: "[redacted:KEY_SECRET]" },
      "[redacted:KEY_SECRET]#2": "public marker-shaped key",
    });
    expect(JSON.stringify(cleaned)).not.toContain(secret);
  });

  test("redacts authorization, cookies, curl credentials, and URL userinfo in traces", () => {
    const trace = [
      "> Authorization: Bearer synthetic-bearer-value-123456",
      "> Authorization: Digest synthetic-digest-value-123456",
      "> Proxy-Authorization: synthetic-opaque-auth-value-123456",
      "> Cookie: session=synthetic-cookie-value-123456; theme=dark",
      "> X-API-Key: synthetic-api-key-value-123456",
      "+ curl -u synthetic-user:synthetic-password https://api.example/v1",
      "clone https://synthetic-user:synthetic-password@git.example/org/repo.git",
      "clone https://synthetic-username@git.example/org/repo.git",
    ].join("\n");
    const cleaned = redactSensitiveText(trace);

    expect(cleaned).toContain("> Authorization: Bearer [redacted]");
    expect(cleaned).toContain("> Authorization: Digest [redacted]");
    expect(cleaned).toContain("> Proxy-Authorization: [redacted]");
    expect(cleaned).toContain("> Cookie: [redacted]");
    expect(cleaned).toContain("> X-API-Key: [redacted]");
    expect(cleaned).toContain("curl -u [redacted] https://api.example/v1");
    expect(cleaned).toContain("https://[redacted]@git.example/org/repo.git");
    expect(cleaned).not.toContain("synthetic-password");
    expect(cleaned).not.toContain("synthetic-digest-value");
    expect(cleaned).not.toContain("synthetic-opaque-auth-value");
    expect(cleaned).not.toContain("synthetic-username");
    expect(cleaned).not.toContain("synthetic-cookie-value");
  });

  test("redacts signed URL material but preserves the route and ordinary query params", () => {
    const value =
      "download https://objects.example/report.csv?version=7&X-Amz-Signature=abcdef1234567890&view=inline";
    const cleaned = redactSensitiveText(value);

    expect(cleaned).toBe(
      "download https://objects.example/report.csv?version=7&X-Amz-Signature=[redacted]&view=inline",
    );
  });

  test("redacts secret-like environment and serialized assignments", () => {
    const value = [
      "SAFE_MODE=diagnostic",
      "export SERVICE_API_KEY=synthetic-api-key-value-123456",
      '{"access_token":"synthetic-access-value-123456","status":"denied"}',
    ].join("\n");
    const cleaned = redactSensitiveText(value);

    expect(cleaned).toContain("SAFE_MODE=diagnostic");
    expect(cleaned).toContain("SERVICE_API_KEY=[redacted]");
    expect(cleaned).toContain('"access_token":"[redacted]"');
    expect(cleaned).toContain('"status":"denied"');
  });

  test("redacts established provider token shapes", () => {
    const tokens = [
      `ghp_${"a".repeat(36)}`,
      `glpat-${"b".repeat(24)}`,
      `sk-${"c".repeat(32)}`,
      `xoxb-${"1".repeat(12)}-${"d".repeat(12)}`,
      `AIza${"e".repeat(35)}`,
      `ogd_${"f".repeat(24)}`,
      `eyJ${"g".repeat(10)}.${"h".repeat(12)}.${"i".repeat(12)}`,
    ];
    const cleaned = redactSensitiveText(tokens.join(" "));

    expect(cleaned).toBe(tokens.map(() => "[redacted]").join(" "));
    for (const token of tokens) expect(cleaned).not.toContain(token);
  });

  test("preserves public tokens/signatures in valid and malformed serialized checkpoints", () => {
    const publicPayload =
      '{"token":"page-2","signature":"sha256=public-digest","mediaType":"application/json"}';
    expect(redactSerializedJson(publicPayload)).toBe(publicPayload);
    expect(redactSerializedJson("token=page-2 signature=sha256=public-digest trailing")).toBe(
      "token=page-2 signature=sha256=public-digest trailing",
    );
  });

  test("redacts registered secrets in valid and malformed serialized checkpoints", () => {
    const knownSecrets = [{ name: "STATE_TOKEN", value: "synthetic-state-token-123456" }];
    expect(
      redactSerializedJson('{"token":"synthetic-state-token-123456","step":3}', knownSecrets),
    ).toBe('{"token":"[redacted:STATE_TOKEN]","step":3}');
    expect(redactSerializedJson("token=synthetic-state-token-123456 trailing", knownSecrets)).toBe(
      "token=[redacted:STATE_TOKEN] trailing",
    );
  });
});
