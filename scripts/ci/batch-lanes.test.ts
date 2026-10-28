import { expect, test } from "bun:test";
import {
  classifyBuildFailure,
  classifyLanes,
  laneJobs,
  readAttemptJobs,
  readJobLog,
  type LaneJob,
} from "./batch-lanes";

const caller = "Main CI lanes";
let nextId = 1;
const job = (
  name: string,
  conclusion: string | null = "success",
  failedStep?: string,
  status = "completed",
): LaneJob => ({
  id: nextId++,
  name,
  status,
  conclusion,
  steps: [
    { name: "Set up job", number: 1, status: "completed", conclusion: "success" },
    ...(failedStep
      ? [{ name: failedStep, number: 2, status: "completed", conclusion: "failure" }]
      : []),
  ],
});
const green = [
  job("Explain change impact"),
  job("Source and type contracts"),
  job("Unit tests (shard 1/1)", "skipped"),
  job("Real-service shard 1/6"),
  job("Impacted E2E shard 1/4"),
  job("Build exact artifact runtime inputs / Native smoke receipt (darwin-x64)"),
  job("Typecheck and unit tests"),
  job("Deployment artifacts"),
  job("Workload image builds"),
];
const noLog = async () => {
  throw new Error("log must not be read");
};
const log = (code: number) => async () =>
  `2026-10-28T10:00:00Z some output\n##[error]Process completed with exit code ${code}.\n`;

test("only this caller's nested jobs are lanes", () => {
  const rows = [
    { id: 1, name: "Batch impact", status: "completed", conclusion: "success", steps: [] },
    {
      id: 2,
      name: "Main CI lanes / Real-service shard 1/6",
      status: "completed",
      conclusion: "success",
      steps: [],
    },
    {
      id: 3,
      name: "Main CI lanes / Build exact artifact runtime inputs / WASM smoke receipt",
      status: "completed",
      conclusion: "skipped",
    },
  ];
  expect(laneJobs(rows, caller).map((row) => row.name)).toEqual([
    "Real-service shard 1/6",
    "Build exact artifact runtime inputs / WASM smoke receipt",
  ]);
});

test("green requires every lane settled and the canary admission jobs green", async () => {
  expect((await classifyLanes("success", green, noLog)).exitCode).toBe(0);
  expect((await classifyLanes("success", [], noLog)).exitCode).toBe(75);
  expect(
    (
      await classifyLanes(
        "success",
        [...green, job("Impacted E2E shard 2/4", null, undefined, "in_progress")],
        noLog,
      )
    ).exitCode,
  ).toBe(75);
  const withoutImages = green.filter((row) => row.name !== "Workload image builds");
  expect(await classifyLanes("success", withoutImages, noLog)).toMatchObject({
    exitCode: 1,
    reason: expect.stringContaining("Workload image builds"),
  });
});

test("cancelled and skipped callers never produce a code verdict", async () => {
  expect((await classifyLanes("cancelled", green, noLog)).exitCode).toBe(130);
  expect((await classifyLanes("skipped", green, noLog)).exitCode).toBe(75);
  expect((await classifyLanes("", green, noLog)).exitCode).toBe(75);
});

test("a failed assertion is a retryable code failure and aggregates are ignored", async () => {
  const jobs = [
    ...green.filter((row) => row.name !== "Typecheck and unit tests"),
    job("Real-service shard 3/6", "failure", "Run real-service shard"),
    job("Typecheck and unit tests", "failure", "Require every lane"),
    job("Real-service shard 4/6", "cancelled"),
  ];
  const result = await classifyLanes("failure", jobs, log(1));
  expect(result.exitCode).toBe(1);
  expect(result.failed.map((row) => row.job)).toEqual(["Real-service shard 3/6"]);
  expect((await classifyLanes("failure", jobs, log(70))).exitCode).toBe(70);
  // Any nonzero assertion exit is normalized to 1.
  expect((await classifyLanes("failure", jobs, log(2))).exitCode).toBe(1);
});

test("an aggregate counts only when no lane failed", async () => {
  const jobs = [
    ...green.filter((row) => row.name !== "Workload image builds"),
    job("Workload image builds", "failure", "Require every image"),
  ];
  expect((await classifyLanes("failure", jobs, log(1))).exitCode).toBe(1);
});

test("deadlines, setup failures, runner loss and unreadable logs are infrastructure", async () => {
  const one = async (row: LaneJob, readLog: (row: LaneJob) => Promise<string | null> = noLog) =>
    (await classifyLanes("failure", [...green, row], readLog)).exitCode;
  expect(
    await one(job("Impacted E2E shard 1/4", "failure", "Run impacted E2E shard"), log(124)),
  ).toBe(124);
  expect(await one(job("Impacted E2E shard 1/4", "timed_out"))).toBe(124);
  expect(await one(job("Real-service shard 1/6", "failure", "Install exact dependency tree"))).toBe(
    75,
  );
  expect(await one(job("Build worker workload image", "failure", "Log in to GHCR"))).toBe(75);
  expect(await one(job("Deployment artifacts", "failure", "Run actions/checkout@v6"))).toBe(75);
  expect(await one(job("Real-service shard 1/6", "failure", "Run tests"), async () => null)).toBe(
    75,
  );
  expect(
    await one(job("Real-service shard 1/6", "failure", "Run tests"), async () => {
      throw new Error("HTTP 500");
    }),
  ).toBe(75);
  expect(
    await one(
      job("Real-service shard 1/6", "failure"),
      async () => "##[error]The runner has received a shutdown signal.",
    ),
  ).toBe(124);
  expect(
    await one(job("Real-service shard 1/6", "failure", "Run tests"), async () => "no exit line"),
  ).toBe(75);
  expect(await one(job("Real-service shard 1/6", "failure", "Run tests"), log(137))).toBe(137);
});

test("a code failure wins over infrastructure siblings; fail-fast alone is infrastructure", async () => {
  const jobs = [
    ...green,
    job("Impacted E2E shard 1/4", "timed_out"),
    job("Real Chromium browser controller", "failure", "Run real Chromium controller"),
  ];
  expect((await classifyLanes("failure", jobs, log(1))).exitCode).toBe(1);
  expect(
    (await classifyLanes("failure", [...green, job("Real-service shard 2/6", "cancelled")], noLog))
      .exitCode,
  ).toBe(75);
});

test("only an aggregate failing beside a cancelled or unsettled lane is infrastructure", async () => {
  const withAggregate = (extra: LaneJob) => [
    ...green.filter((row) => row.name !== "Typecheck and unit tests"),
    extra,
    job("Typecheck and unit tests", "failure", "Require every lane"),
  ];
  expect(
    await classifyLanes(
      "failure",
      withAggregate(job("Real-service shard 2/6", "cancelled")),
      noLog,
    ),
  ).toMatchObject({ exitCode: 75, failed: [] });
  expect(
    (
      await classifyLanes(
        "failure",
        withAggregate(job("Impacted E2E shard 2/4", null, undefined, "in_progress")),
        noLog,
      )
    ).exitCode,
  ).toBe(75);
  // Beside settled green or skipped lanes the aggregate is still a code verdict.
  expect(
    (
      await classifyLanes(
        "failure",
        withAggregate(job("Impacted E2E shard 2/4", "skipped")),
        log(1),
      )
    ).exitCode,
  ).toBe(1);
});

const buildxLog = (...lines: string[]) =>
  [
    "2026-10-28T05:20:00Z #100 [build 4/9] RUN cargo build",
    ...lines,
    "2026-10-28T05:28:04Z ##[error]buildx failed with: ERROR: failed to build: failed to solve: see above",
    "2026-10-28T05:28:05Z Post job cleanup.",
  ].join("\n");
const imageJob = () => job("Build speakers workload image", "failure", "Build and push");

test("image build failures read buildx errors, not a process exit line", async () => {
  const one = async (text: string) =>
    (await classifyLanes("failure", [...green, imageJob()], async () => text)).exitCode;
  // The real ort-sys prebuilt download timeout on main (job 122639851486).
  expect(
    await one(
      buildxLog(
        "#107 1858.3 error: ort-sys@2.0.0-rc.15: extraction of prebuilt binaries downloaded from `https://cdn.pyke.io/0/x.tar.lzma2` failed: Failed to extract to '/root/.cache/libonnxruntime.a': timeout: global",
        "#107 1858.3 error: build script logged errors",
        '#107 ERROR: process "/bin/sh -c xx-cargo build --locked --release" did not complete successfully: exit code: 101',
      ),
    ),
  ).toBe(75);
  // A compile error inside a Dockerfile step is a code failure.
  expect(
    await one(
      buildxLog(
        "#100 41.2 error[E0425]: cannot find value `speaker` in this scope",
        '#100 ERROR: process "/bin/sh -c cargo build --locked" did not complete successfully: exit code: 101',
      ),
    ),
  ).toBe(1);
  expect(
    await one(
      buildxLog(
        '#12 ERROR: failed to calculate checksum of ref abc::def: "/apps/missing": not found',
        'ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "/apps/missing": not found',
      ),
    ),
  ).toBe(1);
  expect(
    await one(
      buildxLog(
        "#5 ERROR: failed to do request: Head https://ghcr.io/v2/x/manifests/y: 429 Too Many Requests",
      ),
    ),
  ).toBe(75);
  expect(
    await one(
      buildxLog(
        '#100 ERROR: process "/bin/sh -c cargo build" did not complete successfully: exit code: 137',
      ),
    ),
  ).toBe(137);
  // Network failures as apt, curl, cargo and bun word them, before a step exit.
  const failedStep =
    '#100 ERROR: process "/bin/sh -c ./install.sh" did not complete successfully: exit code: 100';
  for (const network of [
    "#100 12.1 E: Failed to fetch http://deb.debian.org/debian/pool/main/x.deb  503  Service Unavailable [IP: 151.101.2.132 80]",
    "#100 3.2 curl: (6) Could not resolve host: github.com",
    "#100 3.2 curl: (22) The requested URL returned error: 502",
    "#100 40.0 warning: spurious network error (3 tries remaining): [6] Couldn't resolve host name",
    "#100 41.0 error: failed to download from `https://static.crates.io/crates/x/x-1.0.0.crate`",
    "#100 41.0 Caused by: [6] Couldn't resolve host name (Could not resolve host: static.crates.io)",
    "#100 9.9 GET https://registry.npmjs.org/react - 503",
  ])
    expect(await one(buildxLog(network, failedStep))).toBe(75);
  // The GitHub Actions cache backend losing a blob (headless sandbox job 120883492165).
  expect(
    await one(
      buildxLog(
        "ERROR: failed to build: failed to solve: failed to compute cache key: failed to copy: GET https://productionresultssa9.blob.core.windows.net/actions-cache/20e-1",
        "RESPONSE 404: 404 The specified blob does not exist.",
        "ERROR CODE: BlobNotFound",
      ),
    ),
  ).toBe(75);
  // Echoed Dockerfile commands are not output, so a code failure stays a code failure.
  expect(
    await one(
      buildxLog(
        "#100 [build 4/9] RUN timeout 900 cargo build || echo 'Failed to fetch'",
        "#100 41.2 error[E0425]: cannot find value `speaker` in this scope",
        "------",
        " > [build 4/9] RUN timeout 900 cargo build || echo 'Failed to fetch':",
        "Dockerfile:42",
        "  42 | >>> RUN timeout 900 cargo build || echo 'Failed to fetch'",
        'ERROR: failed to solve: process "/bin/sh -c timeout 900 cargo build" did not complete successfully: exit code: 101',
      ),
    ),
  ).toBe(1);
  // A source position such as `:429` is not a rate limit.
  expect(
    await one(
      buildxLog(
        "#70 2.9 src/routes/index.ts:429:7 - error TS2304: Cannot find name 'x'.",
        '#70 ERROR: process "/bin/sh -c bun run build" did not complete successfully: exit code: 1',
      ),
    ),
  ).toBe(1);
  expect(await one(buildxLog("#100 ERROR: something unexpected"))).toBe(75);
  // A buildx failure wins over an unrelated earlier exit line.
  expect(
    await one(
      `##[error]Process completed with exit code 1.\n${buildxLog("#5 ERROR: unexpected EOF")}`,
    ),
  ).toBe(75);
});

test("build classification ignores non-error lines and uses the last failing step", () => {
  expect(
    classifyBuildFailure([
      "#87 48.78 Selecting previously unselected package libgpg-error0:amd64.",
      "#87 50.00 Get:84 http://deb.debian.org timeout-tools 1.0",
      '#100 ERROR: process "/bin/sh -c bun run build" did not complete successfully: exit code: 2',
    ]),
  ).toEqual({ exitCode: 1, reason: "Dockerfile step exited 2" });
  expect(classifyBuildFailure([]).exitCode).toBe(75);
});

const response = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), init);
const env = {
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "9",
  GITHUB_RUN_ATTEMPT: "2",
  GH_TOKEN: "t",
  GITHUB_API_URL: "https://api.test",
};

test("job listing is exact-attempt, paginated and complete", async () => {
  const urls: string[] = [];
  const pages = [
    { total_count: 3, jobs: [{ id: 1 }, { id: 2 }] },
    { total_count: 3, jobs: [{ id: 3 }] },
  ];
  const rows = await readAttemptJobs(async (url) => {
    urls.push(url);
    return response(pages[urls.length - 1]);
  }, env);
  expect(rows).toHaveLength(3);
  expect(urls[0]).toBe(
    "https://api.test/repos/o/r/actions/runs/9/attempts/2/jobs?per_page=100&page=1",
  );
  await expect(
    readAttemptJobs(async () => response({ total_count: 2, jobs: [{ id: 1 }, { id: 1 }] }), env),
  ).rejects.toThrow("duplicate");
  await expect(
    readAttemptJobs(
      async (url) =>
        response(
          url.endsWith("page=1")
            ? { total_count: 3, jobs: [{ id: 1 }] }
            : { total_count: 3, jobs: [] },
        ),
      env,
    ),
  ).rejects.toThrow("incomplete");
  await expect(readAttemptJobs(async () => response("no", { status: 502 }), env)).rejects.toThrow(
    "HTTP 502",
  );
});

test("job logs follow the signed redirect without the token and stay bounded", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return url.startsWith("https://api.test")
      ? response("", { status: 302, headers: { location: "https://blob.test/log" } })
      : response("x".repeat(100));
  };
  expect(await readJobLog(fetcher, env, 7)).toBe("x".repeat(100));
  expect(seen).toEqual([
    { url: "https://api.test/repos/o/r/actions/jobs/7/logs", auth: "Bearer t" },
    { url: "https://blob.test/log", auth: null },
  ]);
  expect(await readJobLog(fetcher, env, 7, 10)).toBeNull();
  expect(await readJobLog(async () => response("", { status: 404 }), env, 7)).toBeNull();
});
