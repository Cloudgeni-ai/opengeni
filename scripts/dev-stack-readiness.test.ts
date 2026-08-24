import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const scriptUrl = new URL("./dev-stack.sh", import.meta.url);

describe("development stack supervision", () => {
  test("requires aggregate readiness and stops on schema or child-process failure", async () => {
    const source = await readFile(scriptUrl, "utf8");
    expect(source).toContain("wait_for_stack_readiness");
    expect(source).toContain("monitor_dev_stack");
    expect(source).toContain("dev_processes_running");
    expect(source).toContain("signal_process_tree");
    expect(source).toContain("signal_process_tree KILL");
    expect(source).toContain('if [ "$unhealthy_checks" -ge 2 ]');
    expect(source).toContain("sleep 5");
    expect(source).toContain('bun scripts/watch-development-schema.ts "$(pwd)"');
    for (const path of [
      "${OPENGENI_API_PORT}/healthz",
      "${OPENGENI_WORKER_HTTP_PORT}/healthz",
      "${OPENGENI_TURN_WORKER_HTTP_PORT}/healthz",
      "${OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT}/healthz",
      "${OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT}/healthz",
      "${OPENGENI_WEB_PORT}/",
    ]) {
      expect(source).toContain(path);
    }
    expect(source).not.toMatch(/^wait$/mu);
  });
});
