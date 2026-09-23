import { expect, test } from "bun:test";
import {
  externalActorPermissions,
  type ExternalAuthoritySnapshot,
  type ExternalLinkAuthoritySnapshot,
} from "../src/access/external-actor-authority";

const external: ExternalAuthoritySnapshot = {
  accountId: "organization-a",
  externalIdentityId: "external-a",
  identityStatus: "active",
  identityRevision: 1,
  membershipStatus: "active",
  workspaceId: "workspace-a",
  permissions: ["sessions:read", "sessions:create"],
};
const input = {
  accountId: "organization-a",
  workspaceId: "workspace-a",
  keyActive: true,
  keyAccountId: "organization-a",
  keyPermissions: ["workspace:admin", "sessions:read", "sessions:create"] as const,
  external,
  now: 1000,
};
const authority: ExternalLinkAuthoritySnapshot = {
  id: "link-a",
  accountId: "organization-a",
  externalIdentityId: "external-a",
  revision: 2,
  nativeSubjectId: "user:native-a",
  status: "active",
  expiresAt: 2000,
  permissions: ["sessions:read", "sessions:create"],
  nativeAuthority: {
    subjectId: "user:native-a",
    accountId: "organization-a",
    workspaceId: "workspace-a",
    active: true,
    permissions: ["sessions:read"],
  },
};
test("user mode intersects explicit membership with the key ceiling", () => {
  expect(externalActorPermissions(input)).toEqual(["sessions:read", "sessions:create"]);
  expect(externalActorPermissions({ ...input, keyPermissions: ["sessions:read"] })).toEqual([
    "sessions:read",
  ]);
  expect(externalActorPermissions({ ...input, workspaceId: "workspace-b" })).toEqual([]);
});
test("disabled identity, removed membership, revoked key and wrong organization deny", () => {
  expect(externalActorPermissions({ ...input, keyActive: false })).toEqual([]);
  expect(externalActorPermissions({ ...input, keyAccountId: "organization-b" })).toEqual([]);
  expect(
    externalActorPermissions({ ...input, external: { ...external, identityStatus: "disabled" } }),
  ).toEqual([]);
  expect(
    externalActorPermissions({ ...input, external: { ...external, membershipStatus: "revoked" } }),
  ).toEqual([]);
});
test("explicit linking intersects native authority, link scope and key without external permission union", () => {
  expect(
    externalActorPermissions({
      ...input,
      linked: {
        expectedId: authority.id,
        expectedRevision: 2,
        authority: {
          ...authority,
          nativeAuthority: { ...authority.nativeAuthority, subjectId: "user:another" },
        },
      },
    }),
  ).toEqual([]);
  expect(
    externalActorPermissions({
      ...input,
      linked: { expectedId: authority.id, expectedRevision: 2, authority },
    }),
  ).toEqual(["sessions:read"]);
  expect(
    externalActorPermissions({
      ...input,
      linked: { expectedId: authority.id, expectedRevision: 1, authority },
    }),
  ).toEqual([]);
  for (const change of [
    { status: "revoked" as const },
    { expiresAt: 1000 },
    { externalIdentityId: "external-b" },
    { accountId: "organization-b" },
  ]) {
    expect(
      externalActorPermissions({
        ...input,
        linked: {
          expectedId: authority.id,
          expectedRevision: 2,
          authority: { ...authority, ...change },
        },
      }),
    ).toEqual([]);
  }
});

test("linked authority cannot substitute a different link with the same revision", () => {
  for (const expectedId of ["", "another-link"]) {
    expect(
      externalActorPermissions({
        ...input,
        linked: { expectedId, expectedRevision: authority.revision, authority },
      }),
    ).toEqual([]);
  }
});
