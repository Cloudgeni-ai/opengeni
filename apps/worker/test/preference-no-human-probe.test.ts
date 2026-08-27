import { describe, expect, mock, test } from "bun:test";
import { PreferenceRegistryInitiatorError } from "@opengeni/db";

import {
  preferenceSnapshotForTurn,
  preferenceSnapshotHumanSubjectId,
} from "../src/activities/agent-turn/governance-model";

const serviceTurn = {
  initiatingHumanSubjectId: null,
  initiator: { kind: "service" as const, subjectId: "scheduler" },
};

describe("preference snapshot no-human probe", () => {
  test("skips the database capability for a service-only turn", async () => {
    const load = mock(async () => ({ id: "must-not-run" }));

    expect(preferenceSnapshotHumanSubjectId(serviceTurn)).toBeNull();
    expect(await preferenceSnapshotForTurn(serviceTurn, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  test("preserves causal-human and legacy subject preference snapshots", async () => {
    const causalHumanTurn = {
      ...serviceTurn,
      initiatingHumanSubjectId: "user:causal-human",
    };
    const legacySubjectTurn = {
      initiatingHumanSubjectId: null,
      initiator: { kind: "subject" as const, subjectId: "user:legacy-human" },
    };
    expect(preferenceSnapshotHumanSubjectId(causalHumanTurn)).toBe("user:causal-human");
    expect(preferenceSnapshotHumanSubjectId(legacySubjectTurn)).toBe("user:legacy-human");
    expect(await preferenceSnapshotForTurn(causalHumanTurn, async () => "causal-snapshot")).toBe(
      "causal-snapshot",
    );
    expect(await preferenceSnapshotForTurn(legacySubjectTurn, async () => "legacy-snapshot")).toBe(
      "legacy-snapshot",
    );
  });

  test("collapses only the typed initiator race after an eligible probe", async () => {
    const humanTurn = {
      ...serviceTurn,
      initiatingHumanSubjectId: "user:human",
    };
    expect(
      await preferenceSnapshotForTurn(humanTurn, async () => {
        throw new PreferenceRegistryInitiatorError("attempt changed");
      }),
    ).toBeNull();
    await expect(
      preferenceSnapshotForTurn(humanTurn, async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
  });
});
