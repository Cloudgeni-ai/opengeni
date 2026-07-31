import { describe, expect, test } from "bun:test";
import {
  buildMonsterEvents,
  hashHistogram,
  PROFILE_TARGETS,
} from "./builder.ts";
import { TIP_PAGE_EVENTS, TIMELINE_DENSE_TYPES } from "./phases.ts";

const CHILD_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function tipDensity(events: { type: string }[], tipSize = TIP_PAGE_EVENTS): number {
  const tip = events.slice(-Math.min(tipSize, events.length));
  if (tip.length === 0) return 0;
  let dense = 0;
  for (const event of tip) {
    if (TIMELINE_DENSE_TYPES.has(event.type)) dense += 1;
  }
  return dense / tip.length;
}

describe("monster chat seed builder", () => {
  test("ui profile seed=1 produces stable histogram hash", () => {
    const a = buildMonsterEvents({
      profile: "ui",
      seed: 1,
      childSessionIds: CHILD_IDS,
    });
    const b = buildMonsterEvents({
      profile: "ui",
      seed: 1,
      childSessionIds: CHILD_IDS,
    });

    expect(a.events.length).toBe(PROFILE_TARGETS.ui);
    expect(a.histogramHash).toBe(b.histogramHash);
    expect(a.histogram).toEqual(b.histogram);
    expect(hashHistogram(a.histogram)).toBe(a.histogramHash);

    // Pin the hash so accidental generator drift fails CI.
    expect(a.histogramHash).toBe("93d9168e");

    // Conversational lifecycle must be present.
    expect(a.histogram["user.message"] ?? 0).toBeGreaterThan(10);
    expect(a.histogram["turn.queued"] ?? 0).toBeGreaterThan(10);
    expect(a.histogram["turn.started"] ?? 0).toBeGreaterThan(10);
    expect(a.histogram["turn.completed"] ?? 0).toBeGreaterThan(5);
    expect(a.histogram["agent.toolCall.created"] ?? 0).toBeGreaterThan(50);
  });

  test("newest page is timeline-dense chat, not invisible tip pad", () => {
    const built = buildMonsterEvents({
      profile: "ui",
      seed: 1,
      childSessionIds: CHILD_IDS,
    });
    const tip = built.events.slice(-TIP_PAGE_EVENTS);
    expect(tip.length).toBe(TIP_PAGE_EVENTS);
    expect(tipDensity(built.events)).toBeGreaterThan(0.85);

    const noiseTypes = [
      "fs.changed",
      "git.changed",
      "agent.model.usage",
      "terminal.pty.started",
      "artifact.created",
    ];
    let tipNoise = 0;
    for (const event of tip) {
      if (noiseTypes.includes(event.type)) tipNoise += 1;
    }
    expect(tipNoise / tip.length).toBeLessThan(0.1);

    // Tip must end on a settled conversational turn, not seed-pad junk.
    const lastTypes = tip.slice(-8).map((event) => event.type);
    expect(lastTypes.some((type) => type === "turn.completed" || type === "agent.message.completed")).toBe(
      true,
    );
    expect(lastTypes.every((type) => type !== "fs.changed")).toBe(true);
  });

  test("different seeds diverge", () => {
    const a = buildMonsterEvents({
      profile: "ui",
      seed: 1,
      childSessionIds: ["11111111-1111-4111-8111-111111111111"],
    });
    const b = buildMonsterEvents({
      profile: "ui",
      seed: 2,
      childSessionIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(a.histogramHash).not.toBe(b.histogramHash);
  });
});
