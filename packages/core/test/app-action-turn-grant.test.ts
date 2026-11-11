import { expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "../src/access";
import { turnAppActionGrant } from "../src/app-action-turn-grant";

// What a message may do through app actions is frozen when it is accepted:
// changes need a person signed in to the app itself (or a deployment that
// opted its embeds in), and it never carries more than the request's own grant.
const member = "user:member";

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    accountId: "org-1",
    workspaceId: "ws-1",
    subjectId: member,
    principalKind: "human_session",
    permissions: ["workspace:read", "sessions:read", "sessions:create"],
    ...overrides,
  } as AccessGrant;
}

function authorization(
  value: AccessGrant,
  overrides: Partial<AccessGrantAuthorization> = {},
): AccessGrantAuthorization {
  return {
    grant: value,
    accountGrant: { accountId: value.accountId, subjectId: value.subjectId, permissions: [] },
    authenticatedSubjectId: value.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: false,
    canonicalLocalHumanSession: false,
    ...overrides,
  } as AccessGrantAuthorization;
}

test("a person signed in to the app confirms changes, within their own access", () => {
  const value = grant();
  const frozen = turnAppActionGrant({
    grant: value,
    authorization: authorization(value, {
      canonicalManagedHumanSession: true,
      accountGrant: { accountId: "org-1", subjectId: member, permissions: ["billing:read"] },
    }),
    delegatedSignInChangesEnabled: false,
    workspaceSettings: false,
  });
  expect(frozen?.changes).toBe("confirm");
  expect(frozen?.subjectId).toBe(member);
  expect([...(frozen?.permissions ?? [])].sort()).toEqual(
    ["billing:read", "sessions:create", "sessions:read", "workspace:read"].sort(),
  );
  const local = turnAppActionGrant({
    grant: value,
    authorization: authorization(value, { canonicalLocalHumanSession: true }),
    delegatedSignInChangesEnabled: false,
    workspaceSettings: false,
  });
  expect(local?.changes).toBe("confirm");
});

test("an embed's host-issued token can only read, capped by that token", () => {
  // A delegated token can name any member, so its turn never confirms
  // changes and never reaches past the token's own permissions.
  const value = grant({
    permissions: ["workspace:read"],
    metadata: { delegated: true },
  } as Partial<AccessGrant>);
  const frozen = turnAppActionGrant({
    grant: value,
    authorization: authorization(value),
    delegatedSignInChangesEnabled: false,
    workspaceSettings: false,
  });
  expect(frozen).toEqual({ subjectId: member, changes: "none", permissions: ["workspace:read"] });
  // An external user mapped by the host likewise.
  const external = grant({ metadata: { externalActor: { id: "ext" } } } as Partial<AccessGrant>);
  expect(
    turnAppActionGrant({
      grant: external,
      authorization: authorization(external),
      delegatedSignInChangesEnabled: false,
      workspaceSettings: false,
    })?.changes,
  ).toBe("none");
  // A deployment that vouches for its embeds opts them in; the cap stays.
  expect(
    turnAppActionGrant({
      grant: value,
      authorization: authorization(value),
      delegatedSignInChangesEnabled: true,
      workspaceSettings: false,
    }),
  ).toEqual({ subjectId: member, changes: "confirm", permissions: ["workspace:read"] });
});

test("workspace settings are recorded exactly when the request itself could change them", () => {
  // A Personal workspace's owner holds no admin grant there but configures it:
  // their chat records workspace:admin, and nothing else is added.
  const value = grant();
  const owner = turnAppActionGrant({
    grant: value,
    authorization: authorization(value, { canonicalManagedHumanSession: true }),
    delegatedSignInChangesEnabled: false,
    workspaceSettings: true,
  });
  expect([...(owner?.permissions ?? [])].sort()).toEqual(
    ["sessions:create", "sessions:read", "workspace:admin", "workspace:read"].sort(),
  );
  const nonOwner = turnAppActionGrant({
    grant: value,
    authorization: authorization(value, { canonicalManagedHumanSession: true }),
    delegatedSignInChangesEnabled: false,
    workspaceSettings: false,
  });
  expect(nonOwner?.permissions).not.toContain("workspace:admin");
});

test("agents, API keys, services and unverified requests get nothing", () => {
  const cases: AccessGrant[] = [
    grant({ principalKind: "agent_attempt" } as Partial<AccessGrant>),
    grant({ principalKind: "api_key" } as Partial<AccessGrant>),
    grant({ metadata: { delegated: true, turnId: "t", attemptId: "a" } } as Partial<AccessGrant>),
    grant({ serviceInitiator: { kind: "schedule" } } as unknown as Partial<AccessGrant>),
  ];
  for (const value of cases) {
    expect(
      turnAppActionGrant({
        grant: value,
        authorization: authorization(value, { canonicalManagedHumanSession: true }),
        delegatedSignInChangesEnabled: true,
        workspaceSettings: true,
      }),
    ).toBeNull();
  }
  const value = grant();
  expect(
    turnAppActionGrant({
      grant: value,
      authorization: null,
      delegatedSignInChangesEnabled: true,
      workspaceSettings: true,
    }),
  ).toBeNull();
  expect(
    turnAppActionGrant({
      grant: value,
      authorization: authorization(value, { contextIntegrity: false }),
      delegatedSignInChangesEnabled: true,
      workspaceSettings: true,
    }),
  ).toBeNull();
  expect(
    turnAppActionGrant({
      grant: value,
      authorization: authorization(grant({ subjectId: "user:someone-else" }), {
        canonicalManagedHumanSession: true,
      }),
      delegatedSignInChangesEnabled: true,
      workspaceSettings: true,
    }),
  ).toBeNull();
});
