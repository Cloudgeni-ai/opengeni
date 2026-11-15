import { expect, test } from "bun:test";
import {
  buildSandboxImageWithRetry,
  freePort,
  isTransientSandboxBuildFailure,
  sandboxBuildFailureMessage,
} from "../src/compose";

test("sandbox build failures preserve terminal diagnostics in bounded output", () => {
  const message = sandboxBuildFailureMessage({
    exitCode: 1,
    timedOut: false,
    stdout: "build progress\n".repeat(10_000) + "stdout terminal detail",
    stderr: "pull progress\n".repeat(10_000) + "ERROR: terminal failure",
  });
  expect(message).toContain("exit=1 timedOut=false");
  expect(message).toContain("stdout terminal detail");
  expect(message).toContain("ERROR: terminal failure");
  expect(message).toContain("[earlier output omitted]");
  expect(message.length).toBeLessThan(12_250);
});

test("sandbox build failures distinguish timeouts and retain short output", () => {
  const message = sandboxBuildFailureMessage({
    exitCode: 124,
    timedOut: true,
    stdout: "short stdout",
    stderr: "short stderr",
  });
  expect(message).toContain("exit=124 timedOut=true");
  expect(message).toContain("short stdout");
  expect(message).toContain("short stderr");
  expect(message).not.toContain("omitted");
});

test("test listener ports stay outside the Linux ephemeral client range", async () => {
  const ports = await Promise.all(Array.from({ length: 32 }, () => freePort()));

  expect(new Set(ports).size).toBe(ports.length);
  expect(ports.every((port) => port >= 20_000 && port <= 29_999)).toBe(true);

  for (const port of ports) {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    listener.stop(true);
  }
});

const failedBuild = (stderr: string, overrides: { timedOut?: boolean } = {}) => ({
  exitCode: 1,
  timedOut: overrides.timedOut ?? false,
  stdout: "",
  stderr,
});

test("sandbox build network failures are retryable, build errors are not", () => {
  for (const stderr of [
    "#21 ERROR: digest mismatch sha256:bef1: sha256:33e1",
    "#124 ERROR: blob sha256:e5a9aad737a576a6e9ea1a3e1a1e154d103e8bd4b7d1d305173a33eec829fd76: not found",
    "E: Failed to fetch https://snapshot.debian.org/archive/x.deb  TooManyRequests 503  No healthy backends",
    "curl: (56) Recv failure: Connection reset by peer",
    "failed to do request: Head https://registry-1.docker.io: net/http: TLS handshake timeout",
  ]) {
    expect(isTransientSandboxBuildFailure(failedBuild(stderr))).toBe(true);
  }
  for (const stderr of [
    "ERROR: failed to solve: process did not complete successfully: exit code: 2",
    "dpkg: error: failed to write (No space left on device) after E: Failed to fetch x",
    "COPY failed: file not found in build context",
  ]) {
    expect(isTransientSandboxBuildFailure(failedBuild(stderr))).toBe(false);
  }
  expect(isTransientSandboxBuildFailure(failedBuild("digest mismatch", { timedOut: true }))).toBe(
    false,
  );
});

test("only the failing build step decides whether a failure is retryable", () => {
  // Step #7 hit a network error and recovered through apt's own retries;
  // step #12 then failed on a real compile error.
  const recoveredThenRealFailure = [
    "#7 [base 2/6] RUN apt-get update && apt-get install -y curl",
    "#7 3.2 E: Failed to fetch https://snapshot.debian.org/archive/x.deb  503  Service Unavailable",
    "#7 4.9 Get:1 https://snapshot.debian.org/archive/x.deb [120 kB]",
    "#7 DONE 12.0s",
    "#12 [build 4/6] RUN bun run build",
    "#12 8.1 error TS2304: Cannot find name 'missing'.",
    '#12 ERROR: process "/bin/sh -c bun run build" did not complete successfully: exit code: 2',
    "------",
    " > [build 4/6] RUN bun run build:",
    "8.1 error TS2304: Cannot find name 'missing'.",
    "------",
    'ERROR: failed to solve: process "/bin/sh -c bun run build" did not complete successfully: exit code: 2',
  ].join("\n");
  expect(isTransientSandboxBuildFailure(failedBuild(recoveredThenRealFailure))).toBe(false);

  // A parallel step (#9) keeps running after #12 fails, and prints a network
  // error its own retry recovers from; that does not make #12 retryable.
  const interleavedParallelStep = [
    "#9 [fetch 2/3] RUN curl --retry 5 -fsSL https://example.test/tool.tgz -o /tool.tgz",
    "#12 [build 4/6] RUN bun run build",
    "#12 8.1 error TS2304: Cannot find name 'missing'.",
    '#12 ERROR: process "/bin/sh -c bun run build" did not complete successfully: exit code: 2',
    "#9 9.0 curl: (56) Recv failure: Connection reset by peer",
    "#9 9.0 Warning: Problem : connection reset by peer. Will retry in 1 seconds.",
    "#9 CANCELED",
    "------",
    " > [fetch 2/3] RUN curl --retry 5 -fsSL https://example.test/tool.tgz -o /tool.tgz:",
    "9.0 curl: (56) Recv failure: Connection reset by peer",
    "------",
    'ERROR: failed to solve: process "/bin/sh -c bun run build" did not complete successfully: exit code: 2',
  ].join("\n");
  expect(isTransientSandboxBuildFailure(failedBuild(interleavedParallelStep))).toBe(false);

  const failingStepNetworkError = [
    "#7 [base 2/6] RUN apt-get update",
    "#7 DONE 3.0s",
    "#9 [base 3/6] ADD --checksum=sha256:33e1 https://github.com/x/releases/download/v1/x.tgz /x.tgz",
    "#9 ERROR: digest mismatch sha256:bef1: sha256:33e1",
    "ERROR: failed to solve: digest mismatch sha256:bef1: sha256:33e1",
  ].join("\n");
  expect(isTransientSandboxBuildFailure(failedBuild(failingStepNetworkError))).toBe(true);

  // Without step markers, an early recovered error far above the final summary does not count.
  const unmarked = [
    "E: Failed to fetch https://snapshot.debian.org/archive/x.deb  503  Service Unavailable",
    ...Array.from({ length: 40 }, (_, index) => `progress ${index}`),
    "COPY failed: file not found in build context",
    "ERROR: failed to solve: file not found",
  ].join("\n");
  expect(isTransientSandboxBuildFailure(failedBuild(unmarked))).toBe(false);
});

test("sandbox build retries network failures within one overall budget", async () => {
  let clock = 0;
  const timeouts: number[] = [];
  const outcomes = [failedBuild("digest mismatch"), { ...failedBuild(""), exitCode: 0 }];
  const result = await buildSandboxImageWithRetry(
    async (timeoutMs) => {
      timeouts.push(timeoutMs);
      clock += 50_000;
      return outcomes.shift()!;
    },
    { now: () => clock, log: () => undefined },
  );
  expect(result.exitCode).toBe(0);
  // The retry gets only what is left of the budget.
  expect(timeouts).toEqual([600_000, 550_000]);
});

test("sandbox build stops retrying at the attempt limit, a real error or a spent budget", async () => {
  const run = async (
    outcome: ReturnType<typeof failedBuild>,
    elapsedPerAttemptMs: number,
  ): Promise<number> => {
    let clock = 0;
    let attempts = 0;
    await buildSandboxImageWithRetry(
      async () => {
        attempts += 1;
        clock += elapsedPerAttemptMs;
        return outcome;
      },
      { now: () => clock, log: () => undefined },
    );
    return attempts;
  };
  expect(await run(failedBuild("digest mismatch"), 10_000)).toBe(3);
  expect(await run(failedBuild("exit code: 2"), 10_000)).toBe(1);
  expect(await run(failedBuild("digest mismatch"), 500_000)).toBe(1);
});
