import { expect, test } from "bun:test";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import { linkedTurnFirstPartyPermissions } from "../src/activities/agent-turn/tool-environment";

test("linked explicit admin cannot restore unselected worker permissions in an existing broad session", () => {
  const limited = {
    permissions: ["workspace:read", "workspace:admin", "sessions:control"] as const,
    permissionMode: "explicit" as const,
  };
  expect(
    linkedTurnFirstPartyPermissions(null, { ...limited, permissions: [...limited.permissions] }),
  ).toEqual(["workspace:read", "sessions:control"]);
  expect(() =>
    linkedTurnFirstPartyPermissions(["workspace:admin"], {
      ...limited,
      permissions: [...limited.permissions],
    }),
  ).toThrow("cannot delegate a legacy workspace-admin wildcard");
  expect(
    linkedTurnFirstPartyPermissions(["workspace:admin"], {
      permissions: organizationAccessPresetPermissions("full"),
      permissionMode: "explicit",
    }),
  ).toEqual(["workspace:admin"]);
  expect(linkedTurnFirstPartyPermissions(null, { permissions: ["workspace:admin"] })).toContain(
    "connections:read",
  );
});
