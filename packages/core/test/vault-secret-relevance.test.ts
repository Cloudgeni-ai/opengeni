// Which connected vaults a reference miss must check before it is reported
// missing (external vaults §9): the vaults that could change the answer, at
// or above the priority tier that decided the lookup.
import { describe, expect, test } from "bun:test";
import { parseSecretReference } from "@opengeni/contracts";
import type { SecretReferenceCandidate, VaultRow } from "@opengeni/db";
import { relevantProviderVaults } from "../src/domain/vaults/secret-resolver";

const reference = (path: string) => parseSecretReference(["{{secret", `${path}}}`].join(":"));

function vault(id: string, tier: number, source: VaultRow["source"]): VaultRow {
  return { id, name: id, tier, source } as VaultRow;
}

function candidate(
  vaultRow: VaultRow,
  patch: Partial<SecretReferenceCandidate> = {},
): SecretReferenceCandidate {
  return {
    vaultId: vaultRow.id,
    vaultName: vaultRow.name,
    tier: vaultRow.tier,
    source: vaultRow.source,
    archived: false,
    matchedBy: "name",
    missing: "totp_field",
    ...patch,
  } as SecretReferenceCandidate;
}

const onlyMeKeeper = vault("only-me-keeper", 1, "keeper");
const onlyMeHosted = vault("only-me-hosted", 1, "opengeni");
const team = vault("team", 2, "opengeni");
const company = vault("company", 2, "host");
const org = vault("org-1password", 3, "onepassword");
const reachable = [onlyMeKeeper, onlyMeHosted, team, company, org];
const ids = (rows: VaultRow[]) => rows.map((row) => row.id).sort();

describe("relevantProviderVaults", () => {
  test("a hosted match without a one-time password leaves higher-priority connected vaults relevant", () => {
    expect(
      ids(relevantProviderVaults(reference("GitHub/otp"), [candidate(team)], reachable)),
    ).toEqual(["company", "only-me-keeper"]);
  });

  test("lower-priority connected vaults cannot change a miss a higher tier decided", () => {
    const candidates = [candidate(onlyMeHosted), candidate(company), candidate(org)];
    expect(ids(relevantProviderVaults(reference("Jira/otp"), candidates, reachable))).toEqual([
      "only-me-keeper",
    ]);
    // Once the Only-me connected vault matches too, only its own lack is relevant.
    const both = [...candidates, candidate(onlyMeKeeper)];
    expect(ids(relevantProviderVaults(reference("Jira/otp"), both, reachable))).toEqual([
      "only-me-keeper",
    ]);
  });

  test("a connected match that lacks the field stays relevant at the deciding tier", () => {
    expect(
      ids(relevantProviderVaults(reference("GitHub/otp"), [candidate(onlyMeKeeper)], reachable)),
    ).toEqual(["only-me-keeper"]);
    // A complete connected match is not a miss to recheck.
    const complete = candidate(onlyMeKeeper, { missing: null });
    expect(
      ids(relevantProviderVaults(reference("GitHub/otp"), [complete, candidate(team)], reachable)),
    ).toEqual([]);
  });

  test("an explicitly named vault scopes the miss to itself", () => {
    expect(
      ids(relevantProviderVaults(reference("team/GitHub/otp"), [candidate(team)], reachable)),
    ).toEqual([]);
    expect(
      ids(relevantProviderVaults(reference("company/Brand new/value"), [], reachable)),
    ).toEqual(["company"]);
  });

  test("archived matches do not decide the tier", () => {
    const archived = candidate(onlyMeHosted, { archived: true });
    expect(ids(relevantProviderVaults(reference("Brand new"), [archived], reachable))).toEqual([
      "company",
      "only-me-keeper",
      "org-1password",
    ]);
  });
});
