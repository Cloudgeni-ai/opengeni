import { describe, expect, test } from "bun:test";
import {
  valueHiddenError,
  vaultItemRevealable,
  type RevealViewer,
} from "../src/domain/vaults/reveal-policy";

const nobody: RevealViewer = {
  subjectId: null,
  workspaceAdmin: false,
  accountAdmin: false,
  apiKeyRead: false,
};
const person = (subjectId: string, extra: Partial<RevealViewer> = {}): RevealViewer => ({
  ...nobody,
  subjectId,
  ...extra,
});

describe("who can see a stored value", () => {
  test("a shared item: its creator and admins, never other people who may use it", () => {
    for (const vaultOwnerKind of ["workspace", "task"] as const) {
      const item = { vaultOwnerKind, createdBySubjectId: "user:a", useOnly: false };
      expect(vaultItemRevealable(item, person("user:a"))).toBe(true);
      expect(vaultItemRevealable(item, person("user:b"))).toBe(false);
      expect(vaultItemRevealable(item, person("user:b", { workspaceAdmin: true }))).toBe(true);
      // An organization admin administers organization vaults, not this one.
      expect(vaultItemRevealable(item, person("user:b", { accountAdmin: true }))).toBe(false);
      expect(vaultItemRevealable(item, nobody)).toBe(false);
    }
    const org = {
      vaultOwnerKind: "organization" as const,
      createdBySubjectId: "user:a",
      useOnly: false,
    };
    expect(vaultItemRevealable(org, person("user:b", { workspaceAdmin: true }))).toBe(false);
    expect(vaultItemRevealable(org, person("user:b", { accountAdmin: true }))).toBe(true);
  });

  test("an item with no recorded creator is visible only to admins", () => {
    const item = { vaultOwnerKind: "workspace" as const, createdBySubjectId: null, useOnly: false };
    expect(vaultItemRevealable(item, person("user:a"))).toBe(false);
    expect(vaultItemRevealable(item, nobody)).toBe(false);
    expect(vaultItemRevealable(item, person("user:a", { workspaceAdmin: true }))).toBe(true);
  });

  test("an Only me item keeps today's behaviour for its owner", () => {
    const item = { vaultOwnerKind: "user" as const, createdBySubjectId: "user:a", useOnly: false };
    expect(vaultItemRevealable(item, person("user:a"))).toBe(true);
  });

  test("an API key needs the literal secrets:read", () => {
    const item = {
      vaultOwnerKind: "workspace" as const,
      createdBySubjectId: "user:a",
      useOnly: false,
    };
    expect(vaultItemRevealable(item, { ...nobody, apiKeyRead: true })).toBe(true);
  });

  test("a use-only item is shown to nobody, its creator and every admin included", () => {
    const everyone: RevealViewer = {
      subjectId: "user:a",
      workspaceAdmin: true,
      accountAdmin: true,
      apiKeyRead: true,
    };
    for (const vaultOwnerKind of ["user", "workspace", "task", "organization"] as const) {
      expect(
        vaultItemRevealable(
          { vaultOwnerKind, createdBySubjectId: "user:a", useOnly: true },
          everyone,
        ),
      ).toBe(false);
    }
  });

  test("the refusal names the item and why, never a value", () => {
    const hidden = valueHiddenError({ id: "i1", name: "KEY", useOnly: true });
    expect(hidden.code).toBe("vault_permission_denied");
    expect(hidden.details).toMatchObject({ itemId: "i1", reason: "use_only" });
    expect(valueHiddenError({ id: "i1", name: "KEY", useOnly: false }).details).toMatchObject({
      reason: "use_without_reveal",
    });
  });
});
