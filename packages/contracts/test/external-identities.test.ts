import { describe, expect, test } from "bun:test";
import {
  ExternalActorAttribution,
  ExternalActorSelection,
  ExternalIdentityReference,
} from "../src/external-identities";

describe("external actor wire boundary", () => {
  test("opaque IDs preserve valid Unicode while bounding encoded index size", () => {
    const externalId = "😀".repeat(256);
    const source = "😀".repeat(50);
    expect(ExternalIdentityReference.parse({ externalId, source })).toEqual({ externalId, source });
    expect(ExternalIdentityReference.safeParse({ externalId: externalId + "a" }).success).toBe(
      false,
    );
    expect(
      ExternalIdentityReference.safeParse({ externalId: "ok", source: source + "a" }).success,
    ).toBe(false);
    for (const value of ["a\0b", "\uD800", "\uDC00"]) {
      expect(ExternalIdentityReference.safeParse({ externalId: value }).success).toBe(false);
      expect(ExternalIdentityReference.safeParse({ externalId: "ok", source: value }).success).toBe(
        false,
      );
    }
    expect(ExternalIdentityReference.parse({ externalId: "é" }).externalId).not.toBe(
      ExternalIdentityReference.parse({ externalId: "e\u0301" }).externalId,
    );
  });
  test("opaque identifiers retain whitespace, case and native-looking values", () => {
    for (const externalId of ["user:admin", crypto.randomUUID(), " Alice ", "alice"]) {
      expect(ExternalIdentityReference.parse({ externalId })).toEqual({
        externalId,
        source: "default",
      });
    }
  });
  test("native mode is explicit and revision-bound, never inferred from an identifier", () => {
    expect(
      ExternalActorSelection.safeParse({ mode: "external", identity: { externalId: "user:admin" } })
        .success,
    ).toBe(true);
    expect(
      ExternalActorSelection.safeParse({ mode: "linked_native", identity: { externalId: "alice" } })
        .success,
    ).toBe(false);
    expect(
      ExternalActorSelection.safeParse({
        mode: "external",
        identity: { externalId: "alice" },
        effectiveSubjectId: "user:admin",
      }).success,
    ).toBe(false);
  });
  test("external attribution cannot carry a native owner or link", () => {
    const externalSubjectId = `external_user:${crypto.randomUUID()}`;
    const value = {
      accountId: crypto.randomUUID(),
      authenticatingApiKeyId: crypto.randomUUID(),
      externalIdentityId: crypto.randomUUID(),
      externalSubjectId,
      externalAuthorizationRevision: 1,
      effectiveSubjectId: externalSubjectId,
      actingMode: "external",
    };
    expect(ExternalActorAttribution.safeParse(value).success).toBe(true);
    expect(
      ExternalActorAttribution.safeParse({ ...value, effectiveSubjectId: "user:alice" }).success,
    ).toBe(false);
    expect(
      ExternalActorAttribution.safeParse({ ...value, linkId: crypto.randomUUID() }).success,
    ).toBe(false);
    expect(
      ExternalActorAttribution.safeParse({
        ...value,
        actingMode: "linked_native",
        effectiveSubjectId: "user:alice",
        linkId: crypto.randomUUID(),
        linkRevision: 1,
      }).success,
    ).toBe(true);
  });
  test("attribution rejects malformed internal subjects and empty native subjects", () => {
    const externalSubjectId = `external_user:${crypto.randomUUID()}`;
    const value = {
      accountId: crypto.randomUUID(),
      authenticatingApiKeyId: crypto.randomUUID(),
      externalIdentityId: crypto.randomUUID(),
      externalSubjectId,
      externalAuthorizationRevision: 1,
      effectiveSubjectId: externalSubjectId,
      actingMode: "external",
    };
    const malformed = `external_user:${"-".repeat(36)}`;
    expect(
      ExternalActorAttribution.safeParse({
        ...value,
        externalSubjectId: malformed,
        effectiveSubjectId: malformed,
      }).success,
    ).toBe(false);
    for (const effectiveSubjectId of ["user:", "user:alice\n", "configured:alice"]) {
      expect(
        ExternalActorAttribution.safeParse({
          ...value,
          actingMode: "linked_native",
          effectiveSubjectId,
          linkId: crypto.randomUUID(),
          linkRevision: 1,
        }).success,
      ).toBe(false);
    }
  });
});
