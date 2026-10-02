import { afterEach, expect, spyOn, test } from "bun:test";
import * as database from "../src/database";
import * as identities from "../src/external-identities";
import {
  addExternalWorkspaceMemberOperation,
  cancelExternalWorkspaceMemberGrant,
  updateExternalWorkspaceMemberOperation,
} from "../src/external-membership-operations";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  actorSubjectId: "api_key:33333333-3333-4333-8333-333333333333",
  membershipId: "44444444-4444-4444-8444-444444444444",
};
const operationId = "55555555-5555-4555-8555-555555555555";
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

test("keyed external membership operations recheck live scope before receipt or effect", async () => {
  track(
    spyOn(database, "withWorkspaceSubjectRls").mockImplementation(
      async (_db, _workspace, _subject, run) => run({} as never),
    ),
  );
  const lifecycle = track(
    spyOn(identities, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined),
  );
  const key = track(
    spyOn(identities, "lockActiveExternalOrganizationKeyAuthority").mockResolvedValue(null),
  );
  const receipt = track(spyOn(database, "rawRows"));
  for (const operation of [
    () =>
      addExternalWorkspaceMemberOperation({} as never, scope, {
        identity: { source: "fixture", externalId: "person" },
        permissions: ["workspace:read"],
        operationId,
      }),
    () =>
      updateExternalWorkspaceMemberOperation({} as never, scope, {
        permissions: ["workspace:read"],
        operationId,
      }),
    () =>
      cancelExternalWorkspaceMemberGrant({} as never, scope, {
        operationId,
        cancelGrantOperationId: scope.workspaceId,
      }),
  ])
    await expect(operation()).rejects.toMatchObject({ code: "42501" });
  expect(lifecycle).toHaveBeenCalledTimes(3);
  expect(key.mock.calls[0]).toEqual([
    {} as never,
    scope.organizationId,
    scope.actorSubjectId.slice(8),
    scope.workspaceId,
  ]);
  expect(receipt).not.toHaveBeenCalled();
});

test("explicit service admin cannot bypass the literal membership or delegation ceiling", async () => {
  track(
    spyOn(database, "withWorkspaceSubjectRls").mockImplementation(
      async (_db, _workspace, _subject, run) => run({} as never),
    ),
  );
  track(spyOn(identities, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
  const key = track(
    spyOn(identities, "lockActiveExternalOrganizationKeyAuthority").mockResolvedValue({
      permissions: ["workspace:admin"],
      permissionMode: "explicit",
    }),
  );
  const receipt = track(spyOn(database, "rawRows"));
  await expect(
    cancelExternalWorkspaceMemberGrant({} as never, scope, {
      operationId,
      cancelGrantOperationId: scope.workspaceId,
    }),
  ).rejects.toMatchObject({ code: "42501" });
  key.mockResolvedValue({
    permissions: ["members:manage", "workspace:admin"],
    permissionMode: "explicit",
  });
  for (const permissions of [["files:write"], ["workspace:admin"]] as const)
    await expect(
      updateExternalWorkspaceMemberOperation({} as never, scope, {
        operationId,
        permissions: [...permissions],
      }),
    ).rejects.toMatchObject({ code: "42501" });
  expect(receipt).not.toHaveBeenCalled();
});
