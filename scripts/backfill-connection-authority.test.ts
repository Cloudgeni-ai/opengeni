import { describe, expect, test } from "bun:test";
import type { ConnectionAuthorityConvergenceEvidence } from "@opengeni/db";
import {
  connectionAuthorityConvergenceFailed,
  parseBackfillConnectionAuthorityArguments,
} from "./backfill-connection-authority";

function evidence(total: number): ConnectionAuthorityConvergenceEvidence {
  return {
    schemaVersion: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    limit: 1,
    afterConnectionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    items: [],
    returned: 0,
    hasMore: false,
    nextCursor: null,
    remaining: {
      total,
      autoRemediable: 0,
      manualReview: total,
      byClassification: {
        connectionBackfillReady: 0,
        membershipBackfillEligible: 0,
        membershipLifecycleReviewRequired: 0,
        externalSubjectRequiresClassification: total,
        missingLoginIdentity: 0,
        organizationIdentityMismatch: 0,
        missingOwnerWorkspaceMembership: 0,
        conflictingAuthorityRows: 0,
        legacyShapeUnrecognized: 0,
      },
    },
  };
}

describe("connection authority convergence command", () => {
  test("never treats an empty late evidence page as successful", () => {
    expect(
      connectionAuthorityConvergenceFailed({
        incomplete: false,
        evidenceAfter: evidence(1),
        classification: null,
        membershipRemediation: null,
      }),
    ).toBe(true);
    expect(
      connectionAuthorityConvergenceFailed({
        incomplete: false,
        evidenceAfter: evidence(0),
        classification: null,
        membershipRemediation: null,
      }),
    ).toBe(false);
  });

  test("requires explicit apply and fresh membership receipt input", () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    expect(() =>
      parseBackfillConnectionAuthorityArguments([
        "--organization-id",
        organizationId,
        "--remediate-memberships",
      ]),
    ).toThrow("--remediate-memberships requires --apply");
    expect(() =>
      parseBackfillConnectionAuthorityArguments([
        "--organization-id",
        organizationId,
        "--apply",
        "--remediate-memberships",
      ]),
    ).toThrow("--remediate-memberships requires --membership-run-key <fresh-key>");
    expect(() =>
      parseBackfillConnectionAuthorityArguments([
        "--organization-id",
        organizationId,
        "--membership-run-key",
        "unused",
      ]),
    ).toThrow("--membership-run-key requires --remediate-memberships");

    expect(
      parseBackfillConnectionAuthorityArguments([
        "--organization-id",
        organizationId,
        "--apply",
        "--remediate-memberships",
        "--membership-run-key",
        "membership-receipt",
        "--run-key",
        "connection-receipt",
        "--evidence-limit",
        "25",
      ]),
    ).toMatchObject({
      organizationId,
      apply: true,
      remediateMemberships: true,
      membershipRunKey: "membership-receipt",
      runKey: "connection-receipt",
      evidenceLimit: 25,
    });
  });
});
