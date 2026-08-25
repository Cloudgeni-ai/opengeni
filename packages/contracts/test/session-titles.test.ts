import { describe, expect, test } from "bun:test";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  AUTOMATIC_SESSION_TITLE_MAX_GRAPHEMES,
  normalizeAutomaticSessionTitle,
} from "../src/session-titles";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeCount(value: string): number {
  return Array.from(graphemeSegmenter.segment(value)).length;
}

describe("automatic session titles", () => {
  test("removes prompt labels and request boilerplate instead of preserving a first-prompt prefix", () => {
    expect(
      normalizeAutomaticSessionTitle(
        "Title: I want you to please fix automatic chat title generation for long sessions",
      ),
    ).toBe("fix automatic chat title generation for long sessions");
    expect(
      normalizeAutomaticSessionTitle("Could you please investigate OAuth callback failures?"),
    ).toBe("investigate OAuth callback failures");
  });

  test("rejects credentials, token-shaped values, URLs, and opaque identifiers", () => {
    expect(normalizeAutomaticSessionTitle("Debug token sk-proj-abc123456789XYZ")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Password=hunter2 database repair")).toBeNull();
    expect(
      normalizeAutomaticSessionTitle("Inspect https://example.test/login callback"),
    ).toBeNull();
    expect(
      normalizeAutomaticSessionTitle("Investigate request 123e4567-e89b-42d3-a456-426614174000"),
    ).toBeNull();
  });

  test("detects sensitive values through compatibility characters and invisible splits", () => {
    expect(normalizeAutomaticSessionTitle("Password：hunter2 database repair")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Ｐａｓｓｗｏｒｄ=hunter2 database repair")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Debug token sk-proj-abc\u200B123456789XYZ")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Pass\u2060word=hunter2 database repair")).toBeNull();
  });

  test("rejects short alphabetic values assigned to recognized secret labels", () => {
    expect(normalizeAutomaticSessionTitle("Password: swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("api key: secretword")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Token：sesame")).toBeNull();
  });

  test("rejects sensitive suffixes in snake-case, camel-case, and dotted assignment keys", () => {
    expect(normalizeAutomaticSessionTitle("DATABASE_PASSWORD=swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("CLIENT_SECRET=secretword")).toBeNull();
    expect(normalizeAutomaticSessionTitle("GITHUB_TOKEN=sesame")).toBeNull();
    expect(normalizeAutomaticSessionTitle("oauth.clientSecret: swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("prod.private_key=secretword")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Title: DATABASE_PASSWORD=swordfish")).toBeNull();
  });

  test("rejects compact sensitive aliases at namespaced assignment suffixes", () => {
    expect(normalizeAutomaticSessionTitle("DATABASE_APIKEY=swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("OAUTH_ACCESSTOKEN=sesame")).toBeNull();
    expect(normalizeAutomaticSessionTitle("CLIENT_PRIVATEKEY=secretword")).toBeNull();
    expect(normalizeAutomaticSessionTitle("service-AUTHTOKEN: sesame")).toBeNull();
    expect(normalizeAutomaticSessionTitle("oauthAccessToken=swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("prod.apiKey=secretword")).toBeNull();
    expect(normalizeAutomaticSessionTitle("DATABASEAPIKEY=swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("CLIENTPRIVATEKEY=secretword")).toBeNull();
  });

  test("rejects quoted object-literal and JSON secret assignments", () => {
    expect(normalizeAutomaticSessionTitle('{"DATABASE_APIKEY":"swordfish"}')).toBeNull();
    expect(normalizeAutomaticSessionTitle('{"password":"swordfish"}')).toBeNull();
    expect(normalizeAutomaticSessionTitle("{'OAUTH_ACCESSTOKEN':'sesame'}")).toBeNull();
    expect(normalizeAutomaticSessionTitle("｛＂CLIENT_PRIVATEKEY＂：＂secretword＂｝")).toBeNull();
  });

  test("rejects literal backslash-escaped object and JSON secret assignments", () => {
    expect(
      normalizeAutomaticSessionTitle(String.raw`{\"DATABASE_APIKEY\":\"swordfish\"}`),
    ).toBeNull();
    expect(normalizeAutomaticSessionTitle(String.raw`{\"password\":\"swordfish\"}`)).toBeNull();
    expect(
      normalizeAutomaticSessionTitle(String.raw`{\\\"OAUTH_ACCESSTOKEN\\\":\\\"sesame\\\"}`),
    ).toBeNull();
  });

  test("rejects secret key and access key assignment suffix chains", () => {
    expect(normalizeAutomaticSessionTitle("STRIPE_SECRET_KEY=sesame")).toBeNull();
    expect(normalizeAutomaticSessionTitle("AWS_SECRET_ACCESS_KEY=swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("AWS_ACCESS_KEY_ID=shortword")).toBeNull();
    expect(normalizeAutomaticSessionTitle("stripeSecretKey=sesame")).toBeNull();
    expect(normalizeAutomaticSessionTitle("AWSSECRETACCESSKEY=swordfish")).toBeNull();
    expect(normalizeAutomaticSessionTitle("AWSACCESSKEYID=shortword")).toBeNull();
  });

  test("does not reject benign discussion of secret-management concepts", () => {
    expect(normalizeAutomaticSessionTitle("Password reset flow")).toBe("Password reset flow");
    expect(normalizeAutomaticSessionTitle("API key rotation policy")).toBe(
      "API key rotation policy",
    );
    expect(normalizeAutomaticSessionTitle("Secret management rollout")).toBe(
      "Secret management rollout",
    );
    expect(normalizeAutomaticSessionTitle("Database password migration")).toBe(
      "Database password migration",
    );
    expect(normalizeAutomaticSessionTitle("Secret sauce: recipe review")).toBe(
      "Secret sauce: recipe review",
    );
    expect(normalizeAutomaticSessionTitle("MONKEY=swordfish migration")).toBe(
      "MONKEY=swordfish migration",
    );
    expect(normalizeAutomaticSessionTitle("TURNKEY=sesame deployment")).toBe(
      "TURNKEY=sesame deployment",
    );
    expect(normalizeAutomaticSessionTitle("APIKEY rotation policy")).toBe("APIKEY rotation policy");
    expect(normalizeAutomaticSessionTitle("PRIVATEKEYSTONE=secretword rollout")).toBe(
      "PRIVATEKEYSTONE=secretword rollout",
    );
    const escapedBenignObject = String.raw`{\"MONKEY\":\"swordfish\"} review`;
    expect(normalizeAutomaticSessionTitle(escapedBenignObject)).toBe(escapedBenignObject);
  });

  test("uses Unicode normalization only for detection and preserves accepted international text", () => {
    const international = "日本語のデプロイ調査 👩🏽‍💻";
    expect(normalizeAutomaticSessionTitle(international)).toBe(international);
    expect(normalizeAutomaticSessionTitle("ＡＰＩ設計の確認")).toBe("ＡＰＩ設計の確認");
    expect(normalizeAutomaticSessionTitle("👩🏽‍💻 deployment review")).toBe("👩🏽‍💻 deployment review");
    expect(normalizeAutomaticSessionTitle("Coffee ☕️ rollout")).toBe("Coffee ☕️ rollout");
  });

  test("bounds long output at words and complete Unicode graphemes without truncation markers", () => {
    const longWords = normalizeAutomaticSessionTitle(
      "Investigate automatic conversation title generation across retries recovery providers interfaces dashboards integrations and notifications",
    );
    expect(longWords).toBe(
      "Investigate automatic conversation title generation across retries recovery",
    );
    expect(longWords).not.toContain("…");

    const unicode = normalizeAutomaticSessionTitle(`Review ${"👩🏽‍💻".repeat(100)} deployment`);
    expect(unicode).not.toBeNull();
    expect(graphemeCount(unicode!)).toBeLessThanOrEqual(AUTOMATIC_SESSION_TITLE_MAX_GRAPHEMES);
    expect(unicode).not.toContain("�");
  });

  test("returns null for empty/boilerplate-only candidates so callers retain the safe fallback", () => {
    expect(normalizeAutomaticSessionTitle("Title: please")).toBeNull();
    expect(normalizeAutomaticSessionTitle("\n\t\u0000")).toBeNull();
    expect(normalizeAutomaticSessionTitle("\u200B\u2060\uFE0F\u2066\u2069")).toBeNull();
    expect(normalizeAutomaticSessionTitle("Title: \u200B\u2060")).toBeNull();
    expect(AUTOMATIC_SESSION_TITLE_FALLBACK).toBe("New conversation");
  });
});
