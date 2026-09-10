import { expect, test } from "bun:test";
import { InstalledPlugin, PackInstallation } from "../src";

test("composite installation responses preserve pending and customized Skill receipts", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const skillWrites = [
    { operationId: id, skillId: id, revisionId: id, outcome: "pending" as const, replayed: false },
    { operationId: id, skillId: id, revisionId: id, outcome: "preserved" as const, replayed: true },
  ];
  expect(
    InstalledPlugin.parse({
      pluginKey: "example",
      version: "1",
      pluginId: id,
      pluginVersionId: id,
      pluginInstallationId: id,
      installationVersion: 1,
      componentCount: 2,
      status: "installed",
      skillWrites,
    }).skillWrites,
  ).toEqual(skillWrites);
  expect(PackInstallation.shape.skillWrites.parse(skillWrites)).toEqual(skillWrites);
});
