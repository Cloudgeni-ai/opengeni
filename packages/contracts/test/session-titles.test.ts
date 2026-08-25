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

  test("uses Unicode normalization only for detection and preserves accepted international text", () => {
    const international = "日本語のデプロイ調査 👩🏽‍💻";
    expect(normalizeAutomaticSessionTitle(international)).toBe(international);
    expect(normalizeAutomaticSessionTitle("ＡＰＩ設計の確認")).toBe("ＡＰＩ設計の確認");
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
    expect(AUTOMATIC_SESSION_TITLE_FALLBACK).toBe("New conversation");
  });
});
