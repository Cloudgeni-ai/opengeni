type ReadySample = {
  sample: number;
  readyMs: number;
  attempts: number;
  retries: number;
  exitCode: number;
};

type PhaseSample = {
  sample: number;
  processMs: number;
  moduleImportMs: number;
  activityGraphMs: number;
};

if (process.argv.includes("--child-phases")) {
  const moduleStartedAt = performance.now();
  const worker = await import("../apps/worker/src/index");
  const moduleImportMs = performance.now() - moduleStartedAt;
  const activityStartedAt = performance.now();
  await worker.createDefaultWorkerActivities("turn", {});
  const activityGraphMs = performance.now() - activityStartedAt;
  console.log(JSON.stringify({ moduleImportMs, activityGraphMs }));
  process.exit(0);
}

const samples = positiveInteger(flag("--samples") ?? "5", "--samples");
const port = positiveInteger(flag("--port") ?? "8093", "--port");
const timeoutMs = positiveInteger(flag("--timeout-ms") ?? "30000", "--timeout-ms");

const results: ReadySample[] = [];
const phases: PhaseSample[] = [];
for (let sample = 1; sample <= samples; sample += 1) {
  phases.push(await runPhaseSample(sample));
  results.push(await runSample(sample));
}

const ordered = results.map((result) => result.readyMs).toSorted((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      samples: results,
      phases,
      summary: {
        minMs: ordered[0],
        medianMs: ordered[Math.floor(ordered.length / 2)],
        maxMs: ordered.at(-1),
        medianProcessMs: median(phases.map((sample) => sample.processMs)),
        medianModuleImportMs: median(phases.map((sample) => sample.moduleImportMs)),
        medianActivityGraphMs: median(phases.map((sample) => sample.activityGraphMs)),
      },
    },
    null,
    2,
  ),
);

async function runPhaseSample(sample: number): Promise<PhaseSample> {
  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, import.meta.path, "--child-phases"], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const processMs = performance.now() - startedAt;
  if (exitCode !== 0) {
    throw new Error(`turn worker phase sample ${sample} failed: ${stderr.trim()}`);
  }
  const line = stdout
    .trim()
    .split("\n")
    .findLast((entry) => entry.startsWith("{"));
  if (!line) throw new Error(`turn worker phase sample ${sample} emitted no result`);
  const parsed = JSON.parse(line) as { moduleImportMs: number; activityGraphMs: number };
  return {
    sample,
    processMs: round(processMs),
    moduleImportMs: round(parsed.moduleImportMs),
    activityGraphMs: round(parsed.activityGraphMs),
  };
}

async function runSample(sample: number): Promise<ReadySample> {
  const startedAt = performance.now();
  const child = Bun.spawn(
    [process.execPath, "--env-file=.env", "--env-file=.env.runtime", "apps/worker/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENGENI_OBSERVABILITY_STRUCTURED_LOGS: "true",
        OPENGENI_WORKER_HTTP_PORT: String(port),
        OPENGENI_WORKER_ROLE: "turn",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let attempts = 0;
  let readyMs: number | null = null;
  try {
    while (performance.now() - startedAt < timeoutMs) {
      attempts += 1;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(250),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            ok?: unknown;
            state?: unknown;
            checks?: Record<string, { ok?: unknown }>;
          };
          if (
            body.ok === true &&
            body.state === "ready" &&
            Object.values(body.checks ?? {}).every((check) => check.ok === true)
          ) {
            readyMs = performance.now() - startedAt;
            break;
          }
        }
      } catch {
        // The listener is absent until worker construction completes.
      }
      await Bun.sleep(10);
    }
  } finally {
    child.kill("SIGTERM");
  }

  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const output = `${stdout}\n${stderr}`;
  const retries = output.match(/Startup dependency failed; retrying:/gu)?.length ?? 0;
  if (readyMs === null) {
    throw new Error(
      `turn worker sample ${sample} did not become ready within ${timeoutMs} ms ` +
        `(exit ${exitCode}, retries ${retries})`,
    );
  }
  if (!output.includes("OpenGeni worker listening")) {
    throw new Error(`turn worker sample ${sample} reached HTTP readiness without lifecycle ready`);
  }
  if (exitCode !== 0) {
    throw new Error(`turn worker sample ${sample} did not drain cleanly (exit ${exitCode})`);
  }
  return {
    sample,
    readyMs: round(readyMs),
    attempts,
    retries,
    exitCode,
  };
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number | undefined {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
}
