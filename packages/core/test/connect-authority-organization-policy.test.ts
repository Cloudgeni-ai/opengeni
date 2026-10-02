import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { requireConnectOwnerAuthority } from "../src/application/connect-authority";

const state = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "api_key:33333333-3333-4333-8333-333333333333",
};
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

test("Connect live key authority keeps explicit admin literal and preserves legacy wildcard", async () => {
  const lock = spyOn(db, "lockConnectionSetupKeyAuthority").mockResolvedValue({
    permissions: ["workspace:admin"],
    permissionMode: "explicit",
  });
  restores.push(() => lock.mockRestore());
  await expect(requireConnectOwnerAuthority({} as never, state)).rejects.toMatchObject({
    status: 403,
  });
  lock.mockResolvedValue({
    permissions: ["workspace:admin", "connections:write"],
    permissionMode: "explicit",
  });
  await expect(requireConnectOwnerAuthority({} as never, state)).resolves.toBeUndefined();
  lock.mockResolvedValue({ permissions: ["workspace:admin"], permissionMode: "legacy" });
  await expect(requireConnectOwnerAuthority({} as never, state)).resolves.toBeUndefined();
  lock.mockResolvedValue(null);
  await expect(requireConnectOwnerAuthority({} as never, state)).rejects.toMatchObject({
    status: 403,
  });
});
