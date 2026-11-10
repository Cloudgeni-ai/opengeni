import { expect, test } from "bun:test";
import committed from "../../test/integration/sdk-compatibility/versions.json";
import { sdkCompatibilityFailures } from "./sdk-compatibility";

const added = { version: "6.5.1", reason: "New supported release" };
test("committed published versions are exact npm pins; additions keep all older clients", () => {
  expect(sdkCompatibilityFailures(committed)).toEqual([]);
  expect(
    sdkCompatibilityFailures({ ...committed, versions: [...committed.versions, added] }, committed),
  ).toEqual([]);
  expect(
    sdkCompatibilityFailures({
      ...committed,
      versions: [{ version: "latest", reason: "floating" }],
    }),
  ).not.toEqual([]);
});
test("a major bump or elapsed retirement notice cannot drop a tested SDK", () => {
  const notice = {
    version: committed.versions[0]!.version,
    announcedOn: "2026-07-01",
    sunset: "2026-10-01",
    migration: "docs/migration.md",
  };
  const next = { ...committed, versions: committed.versions.slice(1) };
  expect(sdkCompatibilityFailures(next, committed)).toHaveLength(1);
  expect(
    sdkCompatibilityFailures({ ...next, retirementNotices: [notice] }, committed),
  ).toHaveLength(1);
  expect(
    sdkCompatibilityFailures({
      ...committed,
      retirementNotices: [notice],
    }),
  ).toHaveLength(1);
});
