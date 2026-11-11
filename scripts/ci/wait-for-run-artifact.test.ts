import { describe, expect, test } from "bun:test";
import {
  ABSENT_POLLS_WITHOUT_PRODUCER,
  DEADLINE_MS,
  GitHubReadError,
  githubRunReads,
  REFUSED_READS,
  SETTLED_POLLS_WITHOUT_ARTIFACT,
  verdict,
  waitForArtifact,
  type RunJob,
  type RunReads,
} from "./wait-for-run-artifact";

const producer = "Build exact artifact runtime inputs";
const job = (name: string, status: string, conclusion: string | null = null): RunJob => ({
  name: `${producer} / ${name}`,
  status,
  conclusion,
});

describe("verdict", () => {
  test("a listed artifact is ready whatever the jobs say", () => {
    expect(verdict(true, [job("Assemble", "completed", "failure")], producer, 0)).toEqual({
      kind: "ready",
    });
  });

  test("waits while producer jobs run and ignores other jobs", () => {
    const jobs = [
      job("Native smoke receipt (darwin-x64)", "in_progress"),
      job("Assemble", "queued"),
      { name: "Unit tests (1/12)", status: "completed", conclusion: "failure" },
    ];
    expect(verdict(false, jobs, producer, 0)).toEqual({ kind: "wait", pending: 2 });
  });

  test("fails at once when a producer job fails or is cancelled", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const result = verdict(
        false,
        [
          job("Native smoke receipt (win32-x64-msvc)", "completed", conclusion),
          job("Assemble", "queued"),
        ],
        producer,
        0,
      );
      expect(result).toEqual({
        kind: "failed",
        reason: `${producer} / Native smoke receipt (win32-x64-msvc) concluded ${conclusion}`,
      });
    }
  });

  test("gives a settled producer a grace period for the artifact listing", () => {
    const jobs = [job("Assemble", "completed", "success")];
    expect(verdict(false, jobs, producer, SETTLED_POLLS_WITHOUT_ARTIFACT - 1)).toEqual({
      kind: "wait",
      pending: 0,
    });
    expect(verdict(false, jobs, producer, SETTLED_POLLS_WITHOUT_ARTIFACT)).toEqual({
      kind: "failed",
      reason: `${producer} finished without uploading the artifact`,
    });
    expect(
      verdict(
        false,
        [job("Assemble", "completed", "skipped")],
        producer,
        SETTLED_POLLS_WITHOUT_ARTIFACT,
      ),
    ).toEqual({ kind: "failed", reason: `${producer} / Assemble was skipped` });
  });

  test("keeps waiting before the producer's jobs exist", () => {
    expect(verdict(false, [], producer, 100)).toEqual({ kind: "wait", pending: 0 });
    expect(verdict(false, [], producer, 0, ABSENT_POLLS_WITHOUT_PRODUCER - 1)).toEqual({
      kind: "wait",
      pending: 0,
    });
  });

  test("fails when the producer never shows a job", () => {
    expect(verdict(false, [], producer, 0, ABSENT_POLLS_WITHOUT_PRODUCER)).toEqual({
      kind: "failed",
      reason: `${producer} has no job in this run`,
    });
  });

  test("fails when the producer's caller job ends without starting its jobs", () => {
    const caller = (status: string, conclusion: string | null) => [
      { name: producer, status, conclusion },
    ];
    expect(verdict(false, caller("completed", "failure"), producer, 0)).toEqual({
      kind: "failed",
      reason: `${producer} concluded failure`,
    });
    expect(verdict(false, caller("completed", "skipped"), producer, 0)).toEqual({
      kind: "failed",
      reason: `${producer} was skipped`,
    });
    expect(verdict(false, caller("in_progress", null), producer, 0, 1000)).toEqual({
      kind: "wait",
      pending: 0,
    });
  });
});

describe("waitForArtifact", () => {
  function scripted(states: { listed: boolean; jobs: RunJob[] }[]): RunReads & { polls: number } {
    const reads = {
      polls: 0,
      async artifactListed() {
        return states[Math.min(reads.polls, states.length - 1)]!.listed;
      },
      async latestJobs() {
        return states[Math.min(reads.polls++, states.length - 1)]!.jobs;
      },
    };
    return reads;
  }

  test("returns once the artifact appears", async () => {
    const reads = scripted([
      { listed: false, jobs: [job("Assemble", "in_progress")] },
      { listed: false, jobs: [job("Assemble", "in_progress")] },
      { listed: true, jobs: [] },
    ]);
    const slept: number[] = [];
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async (ms) => void slept.push(ms),
      log: () => {},
    });
    expect(result).toEqual({ kind: "ready" });
    expect(slept).toEqual([10_000, 10_000]);
  });

  test("fails when the producer fails", async () => {
    const reads = scripted([
      { listed: false, jobs: [job("Assemble", "in_progress")] },
      { listed: false, jobs: [job("Assemble", "completed", "failure")] },
    ]);
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async () => {},
      log: () => {},
    });
    expect(result.kind).toBe("failed");
  });

  test("fails after a settled producer never lists the artifact", async () => {
    const reads = scripted([{ listed: false, jobs: [job("Assemble", "completed", "success")] }]);
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async () => {},
      log: () => {},
    });
    expect(result).toEqual({
      kind: "failed",
      reason: `${producer} finished without uploading the artifact`,
    });
    expect(reads.polls).toBe(SETTLED_POLLS_WITHOUT_ARTIFACT + 1);
  });

  test("gives up at the deadline", async () => {
    let clock = 0;
    const reads = scripted([{ listed: false, jobs: [job("Assemble", "in_progress")] }]);
    const result = await waitForArtifact(reads, "artifact", producer, {
      deadlineMs: 30_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      log: () => {},
    });
    expect(result).toEqual({ kind: "failed", reason: "artifact did not appear in time" });
  });

  test("fails after the producer shows no job for the grace period", async () => {
    const reads = scripted([{ listed: false, jobs: [] }]);
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async () => {},
      log: () => {},
    });
    expect(result).toEqual({ kind: "failed", reason: `${producer} has no job in this run` });
    expect(reads.polls).toBe(ABSENT_POLLS_WITHOUT_PRODUCER + 1);
  });

  test("ends before the wait step's 60-minute timeout", () => {
    expect(DEADLINE_MS).toBeLessThan(60 * 60_000);
  });

  test("fails after GitHub refuses the reads repeatedly", async () => {
    let calls = 0;
    const reads: RunReads = {
      async artifactListed() {
        calls++;
        throw new GitHubReadError(403, "runs/42/artifacts");
      },
      async latestJobs() {
        return [];
      },
    };
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async () => {},
      log: () => {},
    });
    expect(result.kind).toBe("failed");
    expect(calls).toBe(REFUSED_READS);
  });

  test("a server error between refused reads keeps waiting", async () => {
    const errors = [403, 403, 502, 403, 403];
    let calls = 0;
    const reads: RunReads = {
      async artifactListed() {
        const status = errors[calls++];
        if (status) throw new GitHubReadError(status, "runs/42/artifacts");
        return true;
      },
      async latestJobs() {
        return [];
      },
    };
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async () => {},
      log: () => {},
    });
    expect(result).toEqual({ kind: "ready" });
  });

  test("a failed GitHub read keeps waiting", async () => {
    let calls = 0;
    const reads: RunReads = {
      async artifactListed() {
        if (calls++ === 0) throw new Error("GitHub 502");
        return true;
      },
      async latestJobs() {
        return [];
      },
    };
    const logs: string[] = [];
    const result = await waitForArtifact(reads, "artifact", producer, {
      sleep: async () => {},
      log: (line) => void logs.push(line),
    });
    expect(result).toEqual({ kind: "ready" });
    expect(logs.some((line) => line.includes("GitHub 502"))).toBe(true);
  });
});

describe("githubRunReads", () => {
  test("matches the exact unexpired artifact and pages every latest job", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.includes("/artifacts?"))
        return Response.json({
          artifacts: [
            { name: "artifact-runtime-containers-abc", expired: true },
            { name: "artifact-runtime-containers-abcd", expired: false },
          ],
        });
      const page = Number(new URL(url).searchParams.get("page"));
      const rows = Array.from({ length: page === 1 ? 100 : 3 }, (_, index) => ({
        name: `job ${page}-${index}`,
        status: "completed",
        conclusion: "success",
      }));
      return Response.json({ total_count: 103, jobs: rows });
    }) as unknown as typeof fetch;
    const reads = githubRunReads("o/r", "42", "token", fetcher, { delaysMs: [] });

    expect(await reads.artifactListed("artifact-runtime-containers-abc")).toBe(false);
    expect((await reads.latestJobs()).length).toBe(103);
    expect(urls).toEqual([
      "https://api.github.com/repos/o/r/actions/runs/42/artifacts?name=artifact-runtime-containers-abc&per_page=100",
      "https://api.github.com/repos/o/r/actions/runs/42/jobs?filter=latest&per_page=100&page=1",
      "https://api.github.com/repos/o/r/actions/runs/42/jobs?filter=latest&per_page=100&page=2",
    ]);
  });

  test("a failed read throws instead of looking like a missing artifact", async () => {
    const fetcher = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const reads = githubRunReads("o/r", "42", "token", fetcher, { delaysMs: [] });
    await expect(reads.artifactListed("a")).rejects.toThrow("GitHub 403");
  });
});
