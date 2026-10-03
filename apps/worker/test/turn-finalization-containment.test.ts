import { describe, expect, test } from "bun:test";

async function finalize(mode: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/turn-finalization-containment.ts", import.meta.url).pathname,
      mode,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
  }
}

describe("completed turn physical finalization", () => {
  for (const [mode, stage] of [
    ["writers", "tool_writers"],
    ["snapshot", "workspace_snapshot"],
  ]) {
    test(`drains before host exit when a completed turn stays stuck in ${stage}`, async () => {
      const result = await finalize(mode!);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"phase":"finalizing"');
      expect(result.stdout).toContain('"opAcks":{"settled_op":"42"}');
      expect(result.stdout).toContain(`"reason":"${stage}"`);
      expect(result.stdout).toContain("graceful_drain_requested");
      expect(result.stdout).toContain("host_exit_backstop");
      expect(result.stdout.indexOf("graceful_drain_requested")).toBeLessThan(
        result.stdout.indexOf("host_exit_backstop"),
      );
      expect(result.stdout).not.toContain("finalizer_returned");
      expect(result.stdout).not.toContain("worker_activity");
    }, 30_000);
  }
  test("completed cleanup returns and disarms containment", async () => {
    const result = await finalize("completed");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("finalizer_returned false");
    expect(result.stdout).toContain('"finalizationStage":"sandbox_release"');
    expect(result.stdout).toContain('worker_activity {"activity":"runAgentTurn","status":"idle"');
    expect(result.stdout).not.toContain('"status":"cleanup_failed"');
    expect(result.stdout).not.toContain('"outcome":"containment"');
    expect(result.stdout).not.toContain("graceful_drain_requested");
    expect(result.stdout).not.toContain("host_exit_backstop");
  }, 30_000);
});
