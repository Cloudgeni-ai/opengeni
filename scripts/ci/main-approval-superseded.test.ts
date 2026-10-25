import { expect, test } from "bun:test";
import {
  supersededParkedRuns,
  type ParkedRun,
} from "./main-approval-superseded";

const now = Date.parse("2026-10-25T16:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const run = (
  id: number,
  h: number,
  extra: Partial<ParkedRun> = {},
): ParkedRun => ({
  id,
  headSha: `${id}`.padStart(40, "a"),
  createdAt: hoursAgo(h),
  pendingEnvironments: ["public-release"],
  activeJobs: 0,
  ...extra,
});

test("keeps the newest five parked runs and cancels older superseded ones", () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(100 + i, 10 + i));
  expect(supersededParkedRuns(runs, "f".repeat(40), now)).toEqual([
    105, 106, 107,
  ]);
});

test("never cancels runs younger than three hours or the current main SHA", () => {
  const runs = [
    ...Array.from({ length: 5 }, (_, i) => run(10 + i, 1)),
    run(20, 2),
    run(21, 20, { headSha: "c".repeat(40) }),
    run(22, 20),
  ];
  expect(supersededParkedRuns(runs, "c".repeat(40), now)).toEqual([22]);
});

test("never cancels runs with running jobs or other pending environments", () => {
  const runs = [
    ...Array.from({ length: 5 }, (_, i) => run(10 + i, 1)),
    run(30, 20, { activeJobs: 1 }),
    run(31, 20, { pendingEnvironments: ["public-release", "package-release"] }),
    run(32, 20, { pendingEnvironments: [] }),
    run(33, 20),
  ];
  expect(supersededParkedRuns(runs, "f".repeat(40), now)).toEqual([33]);
});
