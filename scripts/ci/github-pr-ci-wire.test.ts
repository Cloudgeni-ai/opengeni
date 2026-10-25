import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrCiCommand } from "./github-pr-ci";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const old = "a".repeat(40),
  head = "b".repeat(40);
async function fixture(version = false) {
  const root = await mkdtemp(join(tmpdir(), "pr-ci-wire-"));
  roots.push(root);
  const pull = {
    number: 42,
    state: "open",
    head: {
      sha: head,
      ref: version ? "changeset-release/main" : "feature",
      repo: { full_name: "Cloudgeni-ai/opengeni" },
    },
    base: { sha: old, ref: "main" },
    user: { login: "github-actions[bot]" },
    changed_files: 1,
  };
  await Bun.write(
    join(root, "event.json"),
    JSON.stringify({ action: "synchronize", pull_request: structuredClone(pull) }),
  );
  const env = {
    GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
    GITHUB_TOKEN: "fixture",
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: join(root, "event.json"),
    GITHUB_OUTPUT: join(root, "out"),
    VERSION_PR_NUMBER: "42",
    VERSION_HEAD_SHA: head,
  };
  const calls: { path: string; method: string; body: any; query: string }[] = [],
    state = {
      pull,
      changeBeforeCancel: false,
      pullReads: 0,
      existingCurrent: false,
      existingStatus: "queued",
      existingConclusion: null as string | null,
    };
  const transport = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/repos/Cloudgeni-ai/opengeni/", "");
    const method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, query: url.search });
    if (method === "POST") return new Response(null, { status: 204 });
    if (path === "pulls/42") {
      state.pullReads++;
      return Response.json({
        ...pull,
        head: {
          ...pull.head,
          sha: state.changeBeforeCancel && state.pullReads > 1 ? "c".repeat(40) : pull.head.sha,
        },
      });
    }
    if (path === "pulls/42/files") return Response.json([{ filename: "docs/guide.md" }]);
    if (path === "actions/workflows/pr-ci.yml/runs")
      return Response.json({
        workflow_runs: [
          {
            id: 200,
            path: ".github/workflows/pr-ci.yml",
            event: version ? "workflow_dispatch" : "pull_request",
            head_branch: pull.head.ref,
            head_sha: old,
            status: "in_progress",
            run_attempt: 1,
            pull_requests: [{ number: 42 }],
          },
          ...(state.existingCurrent
            ? [
                {
                  id: 201,
                  path: ".github/workflows/pr-ci.yml",
                  event: "workflow_dispatch",
                  head_branch: pull.head.ref,
                  head_sha: head,
                  status: state.existingStatus,
                  conclusion: state.existingConclusion,
                  run_attempt: 1,
                },
              ]
            : []),
        ],
      });
    if (path === "actions/workflows/ci.yml/runs")
      return Response.json({
        workflow_runs: [
          {
            id: 300,
            path: ".github/workflows/ci.yml",
            event: "push",
            head_branch: "main",
            head_sha: old,
            status: "in_progress",
            run_attempt: 1,
            display_title: `Version PR 42 head ${old}`,
          },
        ],
      });
    throw Error(`Unexpected API ${path}`);
  }) as typeof fetch;
  return { root, env, state, calls, transport };
}
test("superseded push cancels only observed old PR CI, not main or batch", async () => {
  const f = await fixture();
  await runPrCiCommand("superseded", f.env, f.transport);
  expect(f.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    "actions/runs/200/cancel",
  ]);
});
test("changed head before cancellation stops without a mutation", async () => {
  const f = await fixture();
  f.state.changeBeforeCancel = true;
  await expect(runPrCiCommand("superseded", f.env, f.transport)).rejects.toThrow("Head changed");
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});
test("Version queue labels explicitly and dispatches exact head; existing current run deduplicates", async () => {
  for (const existing of [false, true]) {
    const f = await fixture(true);
    f.state.existingCurrent = existing;
    await runPrCiCommand("queue-version", f.env, f.transport);
    const writes = f.calls.filter((c) => c.method === "POST");
    expect(writes.find((c) => c.path === "issues/42/labels")?.body).toEqual({
      labels: ["queue-ready"],
    });
    expect(writes.some((c) => c.path === "actions/runs/300/cancel")).toBe(false);
    expect(writes.some((c) => c.path.endsWith("/dispatches"))).toBe(!existing);
    if (!existing)
      expect(writes.find((c) => c.path.endsWith("/dispatches"))?.body).toEqual({
        ref: "changeset-release/main",
        inputs: { pr_number: "42", head_sha: head },
      });
  }
});
test("incomplete file list never grants docs-only bypass", async () => {
  const f = await fixture();
  f.state.pull.changed_files = 2;
  await runPrCiCommand("identity", f.env, f.transport);
  expect(await Bun.file(join(f.root, "out")).text()).toContain("docs_only=false");
});
test("workflow scans are server filtered and failed Version dispatch can be renewed", async () => {
  const f = await fixture(true);
  f.state.existingCurrent = true;
  f.state.existingStatus = "completed";
  f.state.existingConclusion = "failure";
  await runPrCiCommand("queue-version", f.env, f.transport);
  const scans = f.calls.filter((c) => c.path.endsWith("/runs"));
  expect(
    scans.every((c) => c.query.includes("status=") || c.query.includes(`head_sha=${head}`)),
  ).toBe(true);
  expect(f.calls.some((c) => c.path.endsWith("/dispatches") && c.method === "POST")).toBe(true);
  expect(f.calls.at(-1)?.path).toBe("issues/42/labels");
});
test("Version dispatch identity rejects workflow execution on a different SHA", async () => {
  const f = await fixture(true);
  await expect(
    runPrCiCommand(
      "identity",
      { ...f.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: old },
      f.transport,
    ),
  ).rejects.toThrow("exact head");
});
test("provider search truncation refuses Version readiness before any mutation", async () => {
  const f = await fixture(true);
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/runs?"))
      return Response.json({ total_count: 1001, workflow_runs: [] });
    return f.transport(input, init);
  }) as typeof fetch;
  await expect(runPrCiCommand("queue-version", f.env, transport)).rejects.toThrow("search bound");
  expect(f.calls.some((c) => c.method === "POST")).toBe(false);
});
test("priority uses five-minute low-call polling and waits on provider rate hints", async () => {
  let now = 0,
    calls = 0;
  const sleeps: number[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    expect(/\/actions\/workflows\/(ci|batch-ci)\.yml\/runs$/.test(url.pathname)).toBe(true);
    expect(url.searchParams.get("event")).toBe("push");
    if (url.pathname.includes("/workflows/ci.yml/"))
      expect(url.searchParams.get("branch")).toBe("main");
    if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "60" } });
    return Response.json({
      workflow_runs:
        now < 300000
          ? [
              {
                id: 1,
                path: ".github/workflows/ci.yml",
                event: "push",
                head_branch: "main",
                head_sha: head,
                status: "in_progress",
                run_attempt: 1,
              },
            ]
          : [],
    });
  }) as typeof fetch;
  await runPrCiCommand(
    "priority",
    { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture", GITHUB_RUN_ID: "2" },
    transport,
    "pr",
    {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  );
  expect(sleeps).toEqual([60000, 300000]);
  expect(calls).toBe(21);
});

test("short provider inventory holds then rescans without admitting partial demand", async () => {
  let now = 0;
  const paths: string[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    // Reproduced live: HTTP200, reported3, two rows, no next page.
    if (now === 0) return Response.json({ total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] });
    return Response.json({ total_count: 0, workflow_runs: [] });
  }) as typeof fetch;
  await runPrCiCommand(
    "priority",
    { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture" },
    transport,
    "pr",
    {
      now: () => now,
      sleep: async (ms) => {
        expect(ms).toBe(300000);
        now += ms;
      },
    },
  );
  expect(now).toBe(300000);
  expect(paths).toHaveLength(11);
  expect(paths.every((path) => path.includes("/workflows/"))).toBe(true);
});

test.each(["pr", "batch"] as const)(
  "persistent incomplete %s priority inventory expires held without a write",
  async (lane) => {
    let now = 0,
      calls = 0;
    const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect(init?.method).toBe("GET");
      return Response.json({ total_count: 1, workflow_runs: [] });
    }) as typeof fetch;
    await expect(
      runPrCiCommand(
        "priority",
        { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture" },
        transport,
        lane,
        {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      ),
    ).rejects.toThrow("did not clear");
    expect(calls).toBe(60);
    expect(now).toBe(5 * 60 * 60 * 1000);
  },
);

test("continuous new main pushes cannot reset the PR priority yield deadline", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const observedRuns: number[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    const active =
      url.pathname.includes("/ci.yml/runs") && url.searchParams.get("status") === "in_progress";
    const id = 100 + now / 300000;
    if (active) observedRuns.push(id);
    return Response.json({
      total_count: active ? 1 : 0,
      workflow_runs: active
        ? [
            {
              id,
              path: ".github/workflows/ci.yml",
              event: "push",
              head_branch: "main",
              head_sha: head,
              status: "in_progress",
              run_attempt: 1,
            },
          ]
        : [],
    });
  }) as typeof fetch;
  await runPrCiCommand(
    "priority",
    { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture" },
    transport,
    "pr",
    {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  );
  expect(now).toBe(15 * 60 * 1000);
  expect(sleeps).toEqual([300000, 300000, 300000]);
  expect(observedRuns).toEqual([100, 101, 102, 103]);
});

test("PR cap cannot admit an incomplete snapshot at the deadline", async () => {
  let now = 0;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    if (now >= 900000 && now < 1200000) return Response.json({ total_count: 1, workflow_runs: [] });
    const active =
      url.pathname.includes("/ci.yml/runs") && url.searchParams.get("status") === "in_progress";
    return Response.json({
      total_count: active ? 1 : 0,
      workflow_runs: active
        ? [
            {
              id: 7,
              path: ".github/workflows/ci.yml",
              event: "push",
              head_branch: "main",
              head_sha: head,
              status: "in_progress",
              run_attempt: 1,
            },
          ]
        : [],
    });
  }) as typeof fetch;
  await runPrCiCommand(
    "priority",
    { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture" },
    transport,
    "pr",
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  expect(now).toBe(1200000);
});

test("incomplete supersession inventory still fails before any mutation", async () => {
  const f = await fixture();
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/runs?"))
      return Response.json({ total_count: 1, workflow_runs: [] });
    return f.transport(input, init);
  }) as typeof fetch;
  await expect(runPrCiCommand("superseded", f.env, transport)).rejects.toThrow(
    "Incomplete provider inventory",
  );
  expect(f.calls.some((c) => c.method === "POST")).toBe(false);
});

test("malformed priority response is not converted to an empty admission snapshot", async () => {
  let sleeps = 0;
  await expect(
    runPrCiCommand(
      "priority",
      { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture" },
      (async () =>
        Response.json({ total_count: 0, workflow_runs: null })) as unknown as typeof fetch,
      "pr",
      {
        now: () => 0,
        sleep: async () => {
          sleeps++;
        },
      },
    ),
  ).rejects.toThrow("Malformed");
  expect(sleeps).toBe(0);
});

const priorityEnv = { GITHUB_REPOSITORY: "org/repo", GITHUB_TOKEN: "fixture", GITHUB_RUN_ID: "2" };
const fakeTiming = () => {
  const clock = { now: 0, sleeps: [] as number[] };
  return {
    clock,
    timing: {
      now: () => clock.now,
      sleep: async (ms: number) => {
        clock.sleeps.push(ms);
        clock.now += ms;
      },
      random: () => 0.5,
    },
  };
};

test("a read that hits a gateway error or a dropped connection is repeated with backoff", async () => {
  const { clock, timing } = fakeTiming();
  const failures: (number | "network")[] = [502, "network", 504, 503];
  let calls = 0;
  const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(init?.method).toBe("GET");
    const failure = failures.shift();
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure) return new Response("", { status: failure });
    return Response.json({ total_count: 0, workflow_runs: [] });
  }) as typeof fetch;
  await runPrCiCommand("priority", priorityEnv, transport, "pr", timing);
  // Four failed reads, then the ten inventory reads (two workflows, five statuses).
  expect(calls).toBe(14);
  // 2 s, 4 s, 8 s, 16 s, each with half of it as jitter (random 0.5 gives 3/4).
  expect(clock.sleeps).toEqual([1500, 3000, 6000, 12000]);
});

test("a read that keeps failing gives up after bounded retries", async () => {
  const { clock, timing } = fakeTiming();
  let calls = 0;
  const transport = (async () => {
    calls++;
    return new Response("", { status: 502 });
  }) as unknown as typeof fetch;
  await expect(runPrCiCommand("priority", priorityEnv, transport, "pr", timing)).rejects.toThrow(
    "GitHub GET 502",
  );
  expect(calls).toBe(6);
  expect(clock.sleeps).toEqual([1500, 3000, 6000, 12000, 22500]);
});

test("a read that times out is repeated", async () => {
  const { clock, timing } = fakeTiming();
  let calls = 0;
  const transport = (async () => {
    calls++;
    if (calls === 1) throw new DOMException("The operation timed out.", "TimeoutError");
    return Response.json({ total_count: 0, workflow_runs: [] });
  }) as unknown as typeof fetch;
  await runPrCiCommand("priority", priorityEnv, transport, "pr", timing);
  expect(calls).toBe(11);
  expect(clock.sleeps).toEqual([1500]);
});

test("a failed read is not repeated past the admission deadline", async () => {
  const { clock, timing } = fakeTiming();
  const deadline = 5 * 60 * 60 * 1000;
  let calls = 0;
  const transport = (async () => {
    calls++;
    // The first read starts the admission clock; the next fails a second before the deadline.
    if (calls === 1) {
      clock.now = deadline - 1000;
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    return new Response("", { status: 504 });
  }) as unknown as typeof fetch;
  await expect(runPrCiCommand("priority", priorityEnv, transport, "pr", timing)).rejects.toThrow(
    "GitHub GET 504",
  );
  expect(calls).toBe(2);
  expect(clock.sleeps).toEqual([]);
});

test("a mutation that hits a gateway error is never repeated", async () => {
  const f = await fixture();
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      f.calls.push({ path: String(input), method: "POST", body: undefined, query: "" });
      return new Response("", { status: 502 });
    }
    return f.transport(input, init);
  }) as typeof fetch;
  await expect(runPrCiCommand("superseded", f.env, transport)).rejects.toThrow("GitHub POST 502");
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
