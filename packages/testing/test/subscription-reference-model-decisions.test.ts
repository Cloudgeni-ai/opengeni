import { describe, expect, test } from "bun:test";
import {
  checkDecision,
  decide,
  effectiveSettings,
  spreadHash,
  type Decision,
  type InvariantViolation,
  type World,
} from "../src/subscription-reference-model";
import {
  exhaustReferenceConnection,
  generateReferenceWorld,
  REFERENCE_NOW as NOW,
  referenceRandom,
  referenceScenarioWorld,
  updateReferenceSession,
} from "../src/subscription-reference-worlds";

// The reference model's own tests for decisions D-22 to D-25. Titles use the
// `model:` marker: they exercise the model, not production behaviour.

const SEEDS = Array.from({ length: 4000 }, (_, index) => index + 1);

function requirementsFor(decider: (world: World, sessionId: string, now: number) => Decision) {
  const found: InvariantViolation[] = [];
  for (const seed of SEEDS) {
    const { world, sessionId } = generateReferenceWorld(seed);
    found.push(...checkDecision(world, sessionId, NOW, decider(world, sessionId, NOW)));
  }
  return new Set(found.map((violation) => violation.requirement));
}

describe("reference model decisions D-22 to D-25", () => {
  test("model:SUB-WAIT-02, model:SUB-ACCESS-06: the model's own decisions pass the strengthened checks across 4000 generated worlds", () => {
    expect([...requirementsFor(decide)]).toEqual([]);
  });

  test("model:SUB-WAIT-02: omitting, inventing or misplacing a wait's reset time is caught (D-22)", () => {
    const withReset =
      (reset: (now: number) => number | null) => (world: World, id: string, now: number) => {
        const decision = decide(world, id, now);
        return decision.kind === "wait" && decision.reason !== "model_not_allowed"
          ? { ...decision, earliestResetAt: reset(now) }
          : decision;
      };
    expect(requirementsFor(withReset(() => null)).has("SUB-WAIT-02")).toBe(true);
    expect(requirementsFor(withReset((now) => now - 1)).has("SUB-WAIT-02")).toBe(true);
  });

  test("model:SUB-WAIT-02: explaining a wait with the wrong reason is caught", () => {
    const swapped = (world: World, id: string, now: number): Decision => {
      const decision = decide(world, id, now);
      return decision.kind === "wait" && decision.reason === "no_eligible_capacity"
        ? { ...decision, reason: "pinned_account_unavailable" }
        : decision;
    };
    expect(requirementsFor(swapped).has("SUB-WAIT-02")).toBe(true);
  });

  test("model:SUB-ACCESS-06: waiting silently for an explicit choice that can never serve is caught (D-24)", () => {
    const silent = (world: World, id: string, now: number): Decision => {
      const decision = decide(world, id, now);
      return decision.kind === "wait" && decision.reason === "pinned_account_ineligible"
        ? { ...decision, reason: "pinned_account_unavailable" }
        : decision;
    };
    expect(requirementsFor(silent).has("SUB-ACCESS-06")).toBe(true);
  });

  test("model:SUB-SEL-04, model:SUB-WAIT-02: a pinned wait reports when the chosen account can serve again, counting its cooldown (D-22)", () => {
    const world = updateReferenceSession(
      {
        ...exhaustReferenceConnection(referenceScenarioWorld(), "claude-a", NOW + 20_000),
        connections: exhaustReferenceConnection(
          referenceScenarioWorld(),
          "claude-a",
          NOW + 20_000,
        ).connections.map((connection) =>
          connection.id === "claude-a"
            ? { ...connection, modelCooldowns: { "claude/model-a": NOW + 45_000 } }
            : connection,
        ),
      },
      { pinnedConnectionId: "claude-a" },
    );
    expect(decide(world, "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: NOW + 45_000,
    });
    // A pinned account whose reset has passed but that is blocked otherwise
    // never reports a reset in the past.
    const passed = updateReferenceSession(
      {
        ...referenceScenarioWorld(),
        connections: referenceScenarioWorld().connections.map((connection) =>
          connection.id === "claude-a"
            ? { ...connection, healthy: false, quota: { kind: "exhausted", resetsAt: NOW - 1 } }
            : connection,
        ),
      },
      { pinnedConnectionId: "claude-a" },
    );
    expect(decide(passed, "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: null,
    });
  });

  test("model:SUB-ACCESS-06: an explicit choice of another provider's account waits with its own reason (D-24)", () => {
    const world = updateReferenceSession(referenceScenarioWorld(), {
      pinnedConnectionId: "codex-a",
    });
    expect(decide(world, "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "pinned_account_ineligible",
      earliestResetAt: null,
    });
  });

  test("model:SUB-SEL-03: Spread distributes sessions fairly across equal accounts (D-23)", () => {
    const rng = referenceRandom(42);
    const id = () =>
      Array.from({ length: 4 }, () => Math.floor(rng.next() * 2 ** 32).toString(16)).join("-");
    for (const accounts of [2, 3, 5]) {
      for (const naming of ["sequential", "random"] as const) {
        const connections = Array.from({ length: accounts }, (_, index) =>
          naming === "sequential" ? "conn-" + index : id(),
        );
        const counts = new Map(connections.map((connection) => [connection, 0]));
        const sessions = 20_000;
        for (let index = 0; index < sessions; index += 1) {
          const session = naming === "sequential" ? "session-" + index : id();
          const home = connections.reduce((best, connection) =>
            spreadHash(session, connection) < spreadHash(session, best) ? connection : best,
          );
          counts.set(home, counts.get(home)! + 1);
        }
        for (const count of counts.values()) {
          expect(Math.abs(count - sessions / accounts) / (sessions / accounts)).toBeLessThan(0.05);
        }
      }
    }
    // Defined over UTF-16 code units, so ids outside the basic plane hash fully.
    expect(spreadHash("s", "\u{1F600}a")).not.toBe(spreadHash("s", "\u{1F600}b"));
  });

  test("model:SUB-SET-02, model:SUB-SET-03: a workspace overrides one provider's rotation and keeps the others (D-25)", () => {
    const world = referenceScenarioWorld();
    const policy = {
      ...world.settings,
      organization: {
        ...world.settings.organization,
        rotation: {
          claude: { mode: "primary_first" as const, primaryConnectionId: "claude-a" },
          codex: { mode: "primary_first" as const, primaryConnectionId: "codex-a" },
        },
      },
      workspaceOverrides: { "ws-team": { rotation: { codex: { mode: "spread" as const } } } },
    };
    const effective = effectiveSettings(policy, "ws-team");
    expect(effective.values.rotation).toEqual({
      claude: { mode: "primary_first", primaryConnectionId: "claude-a" },
      codex: { mode: "spread" },
    });
    expect(effective.sources.rotation).toBe("workspace");
  });
});
