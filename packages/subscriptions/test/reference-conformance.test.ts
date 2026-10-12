import { describe, expect, test } from "bun:test";
import {
  applyDecision,
  checkDecision,
  decide,
  effectiveSettings as referenceEffectiveSettings,
  type Decision as ReferenceDecision,
  type World as ReferenceWorld,
} from "@opengeni/testing/subscription-reference-model";
import {
  generateTieredReferenceWorld,
  generateReferenceWorld,
  REFERENCE_NOW,
  referenceRandom,
  referenceScenarioCheckpoints,
} from "@opengeni/testing/subscription-reference-worlds";
import {
  bindingStickiness,
  decidePlacement,
  derivedFallbackOrder,
  effectiveSettings,
  hasFallbackOrderEntry,
  SCALAR_SETTING_KEYS,
} from "../src/index";
import { toReferenceDecision } from "../src/reference";
import { mapSettingsPolicy, toPlacementInput } from "./reference-mapping";

// Production decisions are compared with the independent reference model
// (packages/subscriptions/src/reference-model.ts): every decision must
// pass checkDecision and equal the reference decision exactly.

const SEEDS = Array.from({ length: 4000 }, (_, index) => index + 1);
/** Each world is also judged later, as cooldowns and quota windows reset. */
const OFFSETS = [0, 30_000, 120_000];

function production(world: ReferenceWorld, sessionId: string, now: number): ReferenceDecision {
  const input = toPlacementInput(world, sessionId, now);
  return toReferenceDecision(decidePlacement(input), input);
}

type Finding = { seed: number; now: number; detail: unknown };

function generatedFindings(
  judge: (world: ReferenceWorld, sessionId: string, now: number) => unknown,
): Finding[] {
  const findings: Finding[] = [];
  for (const seed of SEEDS) {
    const { world, sessionId } = generateReferenceWorld(seed);
    for (const offset of OFFSETS) {
      const now = REFERENCE_NOW + offset;
      const detail = judge(world, sessionId, now);
      if (detail !== null) findings.push({ seed, now, detail });
    }
  }
  return findings;
}

describe("reference conformance over generated worlds", () => {
  test("every production decision satisfies the contract invariants across 12000 generated placements (SUB-ELIG-01, SUB-ELIG-02, SUB-SEL-02, SUB-SEL-03, SUB-SEL-04, SUB-STICK-02, SUB-FAIL-02, SUB-FAIL-03, SUB-FAIL-04, SUB-WAIT-01, SUB-WAIT-02)", () => {
    const findings = generatedFindings((world, sessionId, now) => {
      const violations = checkDecision(world, sessionId, now, production(world, sessionId, now));
      return violations.length > 0 ? violations : null;
    });
    expect(findings.slice(0, 5)).toEqual([]);
    expect(findings.length).toBe(0);
  });

  test("production and reference decisions are identical across 12000 generated placements (SUB-SEL-01, SUB-SEL-03, SUB-STICK-03, SUB-STICK-05, SUB-STICK-06, SUB-FAIL-03, SUB-FAIL-05, SUB-FAIL-07)", () => {
    const findings = generatedFindings((world, sessionId, now) => {
      const actual = production(world, sessionId, now);
      const expected = decide(world, sessionId, now);
      return Bun.deepEquals(actual, expected) ? null : { production: actual, reference: expected };
    });
    expect(findings.slice(0, 5)).toEqual([]);
    expect(findings.length).toBe(0);
  });

  test("generated worlds exercise every production outcome", () => {
    const outcomes = new Set<string>();
    generatedFindings((world, sessionId, now) => {
      const decision = production(world, sessionId, now);
      outcomes.add(
        decision.kind === "run" ? decision.switch : decision.kind + ":" + decision.reason,
      );
      return null;
    });
    expect([...outcomes].sort()).toEqual(
      [
        "initial",
        "sticky",
        "pinned",
        "reselected_cold",
        "failover_same_provider",
        "failover_cross_provider",
        "return_to_preferred",
        "wait:no_eligible_capacity",
        "wait:pinned_account_unavailable",
        "wait:pinned_account_ineligible",
        "wait:model_not_allowed",
      ].sort(),
    );
  });

  test("the stickiness verdict agrees with every generated placement of an automatic binding (SUB-STICK-02, SUB-STICK-03)", () => {
    const reasons = new Set<string>();
    const findings = generatedFindings((world, sessionId, now) => {
      const input = toPlacementInput(world, sessionId, now);
      const binding = input.session.binding;
      if (!binding || binding.choice !== "automatic") return null;
      const verdict = bindingStickiness(input);
      const decision = decidePlacement(input);
      const onBinding =
        decision.kind === "run" &&
        decision.connectionId === binding.connectionId &&
        decision.modelId === binding.modelId;
      reasons.add(verdict.kind === "keep" ? "keep" : verdict.reason);
      if (verdict.kind === "keep")
        return decision.kind === "run" && decision.switch === "sticky" && onBinding
          ? null
          : { verdict, decision };
      // A forced reason never lands back on the bound account and model
      // (avoidable credits included: an account with included allowance
      // ranks first); a cold cache or a re-selection point may.
      const forced =
        verdict.reason === "account_unavailable" ||
        verdict.reason === "account_ineligible" ||
        verdict.reason === "model_not_permitted" ||
        verdict.reason === "extra_credits";
      return forced && onBinding ? { verdict, decision } : null;
    });
    expect(findings.slice(0, 5)).toEqual([]);
    expect(findings.length).toBe(0);
    for (const reason of ["keep", "cache_cold", "account_ineligible", "reselection_point"])
      expect(reasons.has(reason)).toBe(true);
  });

  test("effective settings and their sources agree with the reference model (SUB-SET-01, SUB-SET-02, SUB-SET-03)", () => {
    for (const seed of SEEDS) {
      const { world } = generateReferenceWorld(seed);
      for (const workspace of world.workspaces) {
        const reference = referenceEffectiveSettings(world.settings, workspace.id);
        const actual = effectiveSettings(mapSettingsPolicy(world), workspace.id);
        expect(actual.values.rotation).toEqual(reference.values.rotation);
        expect(actual.values.fallbackOrder).toEqual(reference.values.fallbackOrder);
        for (const key of SCALAR_SETTING_KEYS) {
          expect(actual.values[key]).toBe(reference.values[key]);
          expect(actual.sources[key]).toBe(reference.sources[key]);
        }
        for (const key of ["rotation", "fallbackOrder"] as const) {
          // Production reports a source per entry; the reference per setting.
          const override = world.settings.workspaceOverrides[workspace.id]?.[key] as
            | Record<string, unknown>
            | undefined;
          const unlocked = !world.settings.locked.includes(key);
          for (const [entry, source] of Object.entries(actual.sources[key])) {
            expect(source).toBe(
              unlocked && override !== undefined && entry in override
                ? "workspace"
                : "organization",
            );
          }
          expect(reference.sources[key]).toBe(
            unlocked && override !== undefined ? "workspace" : "organization",
          );
        }
      }
    }
  });

  test("multi-turn trajectories agree turn by turn as accounts exhaust, reset and caches cool (SUB-STICK-02, SUB-STICK-03, SUB-FAIL-02, SUB-FAIL-07)", () => {
    const disagreements: unknown[] = [];
    for (const seed of SEEDS.slice(0, 600)) {
      const rng = referenceRandom(seed * 7919);
      let { world } = generateReferenceWorld(seed);
      const { sessionId } = generateReferenceWorld(seed);
      let now = REFERENCE_NOW;
      for (let turn = 0; turn < 6; turn += 1) {
        const expected = decide(world, sessionId, now);
        const actual = production(world, sessionId, now);
        if (!Bun.deepEquals(actual, expected)) {
          disagreements.push({ seed, turn, production: actual, reference: expected });
          break;
        }
        const violations = checkDecision(world, sessionId, now, actual);
        if (violations.length > 0) disagreements.push({ seed, turn, violations });
        world = applyDecision(world, sessionId, expected, now);
        // Sometimes the account that just ran is exhausted by that turn.
        if (expected.kind === "run" && rng.bool(0.4)) {
          const resetsAt = now + rng.pick([20_000, 200_000, 2_000_000]);
          world = {
            ...world,
            connections: world.connections.map((connection) =>
              connection.id === expected.connectionId
                ? { ...connection, quota: { kind: "exhausted", resetsAt } }
                : connection,
            ),
          };
        }
        now += rng.pick([1_000, 60_000, 250_000, 400_000, 3_000_000]);
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });
});

describe("reference conformance over tiered generated worlds (D-35)", () => {
  // The same seeds with declared tiers, most fallback entries missing and
  // cross-provider failover usually on, so the derived order decides.
  function tieredFindings(
    judge: (world: ReferenceWorld, sessionId: string, now: number) => unknown,
  ): Finding[] {
    const findings: Finding[] = [];
    for (const seed of SEEDS) {
      const { world, sessionId } = generateTieredReferenceWorld(seed);
      for (const offset of OFFSETS) {
        const now = REFERENCE_NOW + offset;
        const detail = judge(world, sessionId, now);
        if (detail !== null) findings.push({ seed, now, detail });
      }
    }
    return findings;
  }

  test("every production decision satisfies the contract invariants and equals the reference decision when the order is derived (SUB-FAIL-02, SUB-FAIL-03, SUB-FAIL-04, SUB-FAIL-05, SUB-WAIT-01, SUB-WAIT-02)", () => {
    const findings = tieredFindings((world, sessionId, now) => {
      const actual = production(world, sessionId, now);
      const violations = checkDecision(world, sessionId, now, actual);
      const expected = decide(world, sessionId, now);
      return violations.length === 0 && Bun.deepEquals(actual, expected)
        ? null
        : { violations, production: actual, reference: expected };
    });
    expect(findings.slice(0, 5)).toEqual([]);
    expect(findings.length).toBe(0);
  });

  test("tiered worlds reach the derived order: runs on derived models of another provider, explicit empty entries and untiered preferred models (SUB-FAIL-03)", () => {
    let derivedRuns = 0;
    let explicitEmpty = 0;
    let untieredPreferred = 0;
    tieredFindings((world, sessionId, now) => {
      const input = toPlacementInput(world, sessionId, now);
      const preferredId = input.session.preferredModelId;
      if (!hasFallbackOrderEntry(input.settings, preferredId)) {
        const decision = decidePlacement(input);
        if (decision.kind === "run" && derivedFallbackOrder(input).includes(decision.modelId))
          derivedRuns += 1;
        const preferred = input.models.find((model) => model.id === preferredId);
        if (input.settings.crossProviderFailover && !preferred?.tier) untieredPreferred += 1;
      } else if (input.settings.fallbackOrder[preferredId]!.length === 0) {
        explicitEmpty += 1;
      }
      return null;
    });
    expect(derivedRuns).toBeGreaterThan(100);
    expect(explicitEmpty).toBeGreaterThan(100);
    expect(untieredPreferred).toBeGreaterThan(100);
  });

  test("multi-turn trajectories over tiered worlds agree turn by turn (SUB-FAIL-03, SUB-FAIL-07)", () => {
    const disagreements: unknown[] = [];
    for (const seed of SEEDS.slice(0, 600)) {
      const rng = referenceRandom(seed * 6_007);
      let { world } = generateTieredReferenceWorld(seed);
      const { sessionId } = generateTieredReferenceWorld(seed);
      let now = REFERENCE_NOW;
      for (let turn = 0; turn < 6; turn += 1) {
        const expected = decide(world, sessionId, now);
        const actual = production(world, sessionId, now);
        if (!Bun.deepEquals(actual, expected)) {
          disagreements.push({ seed, turn, production: actual, reference: expected });
          break;
        }
        world = applyDecision(world, sessionId, expected, now);
        if (expected.kind === "run" && rng.bool(0.4)) {
          const resetsAt = now + rng.pick([20_000, 200_000, 2_000_000]);
          world = {
            ...world,
            connections: world.connections.map((connection) =>
              connection.id === expected.connectionId
                ? { ...connection, quota: { kind: "exhausted", resetsAt } }
                : connection,
            ),
          };
        }
        now += rng.pick([1_000, 60_000, 250_000, 400_000, 3_000_000]);
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });
});

describe("reference conformance over the scripted scenarios", () => {
  for (const checkpoint of referenceScenarioCheckpoints()) {
    test("conformance: " + checkpoint.title, () => {
      const actual = production(checkpoint.world, checkpoint.sessionId, checkpoint.now);
      expect(actual).toEqual(decide(checkpoint.world, checkpoint.sessionId, checkpoint.now));
      if (checkpoint.exact) expect(actual).toEqual(checkpoint.expected as ReferenceDecision);
      else expect(actual).toMatchObject(checkpoint.expected);
      expect(checkDecision(checkpoint.world, checkpoint.sessionId, checkpoint.now, actual)).toEqual(
        [],
      );
    });
  }
});
