import { describe, expect, test } from "bun:test";
import {
  AddExternalWorkspaceMemberRequest,
  END_USER_DISPLAY_NAME_MAX,
  ExternalActorSelection,
  ExternalIdentityReference,
  normalizeEndUserProfile,
  splitExternalIdentityProfile,
} from "../src/external-identities";

describe("end-user display details", () => {
  test("requests without display details parse exactly as before", () => {
    const external = { mode: "external", identity: { externalId: "auth0|66b45b" } };
    expect(ExternalActorSelection.parse(external)).toEqual({
      mode: "external",
      identity: { externalId: "auth0|66b45b", source: "default" },
    });
    const linked = {
      mode: "linked_native" as const,
      identity: { externalId: "u-1", source: "product" },
      linkId: "6f1c2d4e-7a3b-4c5d-8e9f-0a1b2c3d4e5f",
      expectedLinkRevision: 3,
    };
    expect(ExternalActorSelection.parse(linked)).toEqual(linked);
    const member = {
      identity: { externalId: "u-1" },
      permissions: ["sessions:read"],
    };
    expect(AddExternalWorkspaceMemberRequest.parse(member)).toEqual({
      identity: { externalId: "u-1", source: "default" },
      permissions: ["sessions:read"],
    });
  });

  test("display details are accepted and never part of the identity", () => {
    const parsed = ExternalActorSelection.parse({
      mode: "external",
      identity: { externalId: "u-1", displayName: "  Ada  Lovelace ", email: "ada@example.com" },
    });
    const { identity, profile } = splitExternalIdentityProfile(parsed.identity);
    expect(identity).toEqual({ externalId: "u-1", source: "default" });
    expect(ExternalIdentityReference.parse(identity)).toEqual(identity);
    expect(profile).toEqual({ displayName: "Ada Lovelace", email: "ada@example.com" });
    const member = AddExternalWorkspaceMemberRequest.parse({
      identity: { externalId: "u-1", source: "product", displayName: "Ada" },
      permissions: ["sessions:read"],
    });
    expect(splitExternalIdentityProfile(member.identity)).toEqual({
      identity: { externalId: "u-1", source: "product" },
      profile: { displayName: "Ada" },
    });
    // The stored identity reference stays strict.
    expect(
      ExternalIdentityReference.safeParse({ externalId: "u-1", displayName: "Ada" }).success,
    ).toBe(false);
  });

  test("normalization is lenient: bounded, trimmed, never an error", () => {
    // Null or non-string display details are ignored, never a rejected request.
    const actor = ExternalActorSelection.parse({
      mode: "external",
      identity: { externalId: "u-1", source: "product", displayName: null, email: 42 },
    });
    expect(splitExternalIdentityProfile(actor.identity)).toEqual({
      identity: { externalId: "u-1", source: "product" },
      profile: {},
    });
    const memberWithNulls = AddExternalWorkspaceMemberRequest.parse({
      identity: { externalId: "u-1", displayName: { first: "Ada" }, email: null },
      permissions: ["sessions:read"],
    });
    expect(splitExternalIdentityProfile(memberWithNulls.identity)).toEqual({
      identity: { externalId: "u-1", source: "default" },
      profile: {},
    });
    // Unknown keys are still rejected: only the two display details are lenient.
    expect(
      ExternalActorSelection.safeParse({
        mode: "external",
        identity: { externalId: "u-1", nickname: "Ada" },
      }).success,
    ).toBe(false);
    expect(normalizeEndUserProfile({})).toEqual({});
    expect(normalizeEndUserProfile({ displayName: "   ", email: "" })).toEqual({});
    expect(normalizeEndUserProfile({ displayName: 42, email: { a: 1 } })).toEqual({});
    expect(normalizeEndUserProfile({ displayName: "Ada\u0000\nKing" })).toEqual({
      displayName: "Ada King",
    });
    const long = "é".repeat(END_USER_DISPLAY_NAME_MAX + 50);
    expect(normalizeEndUserProfile({ displayName: long }).displayName).toHaveLength(
      END_USER_DISPLAY_NAME_MAX,
    );
    // Cutting never splits a surrogate pair.
    const emoji = normalizeEndUserProfile({ displayName: "😀".repeat(300) }).displayName!;
    expect(Array.from(emoji)).toHaveLength(END_USER_DISPLAY_NAME_MAX);
    expect(/[\uD800-\uDBFF]$/u.test(emoji)).toBe(false);
    // A malformed email is stored as given (no warning channel); one that cannot be an address is dropped.
    expect(normalizeEndUserProfile({ email: "not-an-email" })).toEqual({ email: "not-an-email" });
    expect(normalizeEndUserProfile({ email: " ada@example.com " })).toEqual({
      email: "ada@example.com",
    });
    expect(normalizeEndUserProfile({ email: "ada lovelace@example.com" })).toEqual({});
    expect(normalizeEndUserProfile({ email: `${"a".repeat(320)}@x.io` })).toEqual({});
    expect(normalizeEndUserProfile({ displayName: "\uD800Ada" })).toEqual({ displayName: "Ada" });
  });
});
