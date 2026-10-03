import { afterEach, expect, spyOn, test } from "bun:test";
import * as database from "../src/database";
import * as linkedWork from "../src/external-link-work";
import { resolveAcceptedConnectionUse } from "../src/connection-authority";

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
test("linked explicit admin without connections:read cannot reach native credential resolution", async () => {
  const context = spyOn(database, "withRlsContext").mockImplementation(async (_db, _scope, run) =>
    run({} as never),
  );
  const linked = spyOn(linkedWork, "getExternalLinkTurnAuthorization").mockResolvedValue({
    authorized: true,
    permissions: ["workspace:admin"],
    permissionMode: "explicit",
  });
  const native = spyOn(database, "rawRows");
  restores.push(
    () => context.mockRestore(),
    () => linked.mockRestore(),
    () => native.mockRestore(),
  );
  expect(
    await resolveAcceptedConnectionUse({} as never, {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      physicalRequestId: crypto.randomUUID(),
      usePhase: "credential_resolution",
      serverId: "fixture",
      providerDomain: "fixture.example",
    }),
  ).toEqual({ status: "denied", reason: "grant_status_inactive" });
  expect(native).not.toHaveBeenCalled();
});
