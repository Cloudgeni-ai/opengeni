import { expect, test } from "bun:test";
import committed from "../../test/integration/sdk-compatibility/versions.json";
import { sdkCompatibilityFailures } from "./sdk-compatibility";

const now = new Date("2026-11-03T00:00:00Z");
const added = { version: "6.5.1", reason: "New supported release" };
test("committed published versions are exact npm pins; additions keep all older clients", () => {
  expect(sdkCompatibilityFailures(committed)).toEqual([]);
  expect(
    sdkCompatibilityFailures(
      { ...committed, versions: [...committed.versions, added] },
      committed,
      now,
    ),
  ).toEqual([]);
  expect(
    sdkCompatibilityFailures({
      ...committed,
      versions: [{ version: "latest", reason: "floating" }],
    }),
  ).not.toEqual([]);
});
test("a major bump or a same-PR backdated announcement cannot drop a supported SDK", () => {
  const notice = {
    version: committed.versions[0]!.version,
    announcedOn: "2026-07-01",
    sunset: "2026-10-01",
    migration: "docs/migration.md",
  };
  const next = { ...committed, versions: committed.versions.slice(1), retirementNotices: [notice] };
  expect(sdkCompatibilityFailures(next, committed, now)).toHaveLength(1);
  expect(
    sdkCompatibilityFailures(next, { ...committed, retirementNotices: [notice] }, now),
  ).toEqual([]);
  expect(
    sdkCompatibilityFailures(
      next,
      { ...committed, retirementNotices: [{ ...notice, sunset: "2027-01-01" }] },
      now,
    ),
  ).toHaveLength(1);
  expect(
    sdkCompatibilityFailures({
      ...committed,
      retirementNotices: [{ ...notice, sunset: "2026-07-02" }],
    }),
  ).toHaveLength(1);
});
