// A machine that cannot start programs: the agent's spawn error is reduced to
// the program it started (never the command text), is never a missing-path
// answer, renders actionable tool output, and a compute box can be restarted.

import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@opengeni/agent-proto";
import {
  ComputeControlClient,
  agentErrorToControlError,
  renderSelfhostedFault,
  selfhostedFaultClass,
  SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES,
} from "../src/sandbox";
import { isDefinitePathNotFoundError } from "../src/sandbox/channel-a";

const SCRIPT = `node -e '\nconst fs = require("node:fs");\nthrow Error("Codemode client transfer integrity failure");\n' '/workspace/x.json'`;
const OS = "No such file or directory (os error 2)";

/** The message the runtime keeps for an agent's spawn error message. */
function sanitizeProcessStartFailureMessage(message: string): string {
  return agentErrorToControlError({
    code: ErrorCode.ERROR_CODE_NOT_FOUND,
    message,
    retryable: false,
    detail: {},
  }).message;
}

/** A newer agent's message, which quotes the program it started. */
function spawnError(program: string, note = "", code = ErrorCode.ERROR_CODE_NOT_FOUND) {
  return agentErrorToControlError({
    code,
    message: `not found: spawn or apply execution containment for program "${program}"${note}: ${OS}`,
    retryable: false,
    detail: {},
  });
}

/** An older agent's message, which put the first command element there unquoted. */
function legacySpawnError(reported: string, code = ErrorCode.ERROR_CODE_NOT_FOUND) {
  return agentErrorToControlError({
    code,
    message: `not found: spawn or apply execution containment for ${reported}: ${OS}`,
    retryable: false,
    detail: {},
  });
}

describe("process-start failures from the machine agent", () => {
  test("an old agent's whole shell script becomes 'a shell command'", () => {
    expect(
      sanitizeProcessStartFailureMessage(
        `not found: spawn or apply execution containment for ${SCRIPT}: ${OS}`,
      ),
    ).toBe(`not found: spawn or apply execution containment for a shell command: ${OS}`);
  });

  test("a quoted program, its null-device note and an old agent's plain name are kept", () => {
    expect(
      sanitizeProcessStartFailureMessage(
        `spawn or apply execution containment for program "/bin/bash" (the null device /dev/null is missing): ${OS}`,
      ),
    ).toBe(
      `spawn or apply execution containment for program "/bin/bash" (the null device /dev/null is missing): ${OS}`,
    );
    expect(
      sanitizeProcessStartFailureMessage(`spawn or apply execution containment for git: ${OS}`),
    ).toBe(`spawn or apply execution containment for git: ${OS}`);
  });

  test("sanitizing is idempotent and leaves other messages alone", () => {
    for (const message of [
      `spawn or apply execution containment for ${SCRIPT}: ${OS}`,
      `spawn or apply execution containment for program "/bin/sh" (the null device /dev/null is missing): ${OS}`,
      `spawn or apply execution containment for echo: TOKEN=sk-live-123; curl x: ${OS}`,
    ]) {
      const once = sanitizeProcessStartFailureMessage(message);
      expect(sanitizeProcessStartFailureMessage(once)).toBe(once);
    }
    expect(sanitizeProcessStartFailureMessage("exit status 1")).toBe("exit status 1");
  });

  test("an old agent's command text is never kept, around a plain name or not", () => {
    for (const reported of [
      // A short shell command with a secret and no spaces.
      "TOKEN=sk-live-abc123;curl",
      // A name followed by command text that is not the null-device note.
      "deploy (TOKEN=sk-live-123)",
    ]) {
      const kept = sanitizeProcessStartFailureMessage(
        `spawn or apply execution containment for ${reported}: ${OS}`,
      );
      expect(kept).toBe(`spawn or apply execution containment for a shell command: ${OS}`);
      expect(kept).not.toContain("sk-live");
    }
    // A plain first word, then the rest of the script before the OS error.
    const afterName = sanitizeProcessStartFailureMessage(
      `spawn or apply execution containment for echo: TOKEN=sk-live-123; curl x: ${OS}`,
    );
    expect(afterName).toBe(`spawn or apply execution containment for echo: ${OS}`);
    // Without an OS error nothing after an old agent's name is kept.
    expect(
      sanitizeProcessStartFailureMessage(
        "spawn or apply execution containment for echo: TOKEN=sk-live-123; curl x",
      ),
    ).toBe("spawn or apply execution containment for echo");
  });

  test("a quoted program keeps the rest of the agent's message on one line", () => {
    expect(
      sanitizeProcessStartFailureMessage(
        'spawn or apply execution containment for program "/bin/sh": run_as requires Linux',
      ),
    ).toBe('spawn or apply execution containment for program "/bin/sh": run_as requires Linux');
    expect(
      sanitizeProcessStartFailureMessage(
        'spawn or apply execution containment for program "/bin/sh": write /sys/fs/cgroup/op-1/cgroup.procs:\nPermission denied (os error 13)',
      ),
    ).toBe(
      'spawn or apply execution containment for program "/bin/sh": write /sys/fs/cgroup/op-1/cgroup.procs: Permission denied (os error 13)',
    );
  });

  test("only a machine that cannot start programs is flagged; one missing program is a missing path", () => {
    const missing = spawnError("/nonexistent/opengeni-missing-program");
    expect(missing.processStartFailed).toBe(false);
    expect(missing.osNotFound).toBe(true);
    expect(selfhostedFaultClass(missing)).toBe("not_found");
    expect(legacySpawnError("/nonexistent/opengeni-missing-program").processStartFailed).toBe(
      false,
    );
    const denied = spawnError("/usr/local/bin/tool", "", ErrorCode.ERROR_CODE_OS);
    expect(denied.processStartFailed).toBe(false);
    // Brief resource pressure never restarts a machine other sessions may share.
    const exhausted = agentErrorToControlError({
      code: ErrorCode.ERROR_CODE_OS,
      message:
        'spawn or apply execution containment for program "/bin/sh": Resource temporarily unavailable (os error 11)',
      retryable: false,
      detail: { errno: "11" },
    });
    expect(exhausted.processStartFailed).toBe(false);
    // Program names that are not plain path characters are still names.
    for (const program of [
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Program Files\\Tool\\tool.exe",
      "/opt/my tools/run",
      "/usr/bin/café",
      `/usr/bin/${"x".repeat(160)}…`,
    ]) {
      const error = spawnError(program);
      expect(error.processStartFailed).toBe(false);
      expect(error.osNotFound).toBe(true);
    }
    for (const program of [
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Program Files\\Tool\\tool.exe",
      "\\\\server\\share\\tool.exe",
      "/usr/bin/café",
    ]) {
      expect(legacySpawnError(program).processStartFailed).toBe(false);
    }
    expect(
      spawnError("/bin/bash", " (the null device /dev/null is missing)").processStartFailed,
    ).toBe(true);
    expect(
      spawnError(
        "/bin/sh",
        " (/dev/null has been replaced by something other than the null device)",
      ).processStartFailed,
    ).toBe(true);
    // An old agent that could not start its shell reported the script.
    expect(legacySpawnError(SCRIPT).processStartFailed).toBe(true);
  });

  test("an old agent's command text is removed from the error's detail too", () => {
    const error = agentErrorToControlError({
      code: ErrorCode.ERROR_CODE_OS,
      message: `spawn or apply execution containment for ${SCRIPT}: Permission denied (os error 13)`,
      retryable: false,
      detail: { context: `spawn or apply execution containment for ${SCRIPT}`, errno: "13" },
    });
    expect(error.detail.context).toBe("spawn or apply execution containment for a shell command");
    expect(error.detail.errno).toBe("13");
    expect(JSON.stringify(error.detail)).not.toContain("node -e");
  });

  test("the error is typed, short, and never a missing path", () => {
    for (const code of [ErrorCode.ERROR_CODE_NOT_FOUND, ErrorCode.ERROR_CODE_OS]) {
      const error = legacySpawnError(SCRIPT, code);
      expect(error.processStartFailed).toBe(true);
      expect(error.osNotFound).toBe(false);
      expect(isDefinitePathNotFoundError(error)).toBe(false);
      expect(error.message).not.toContain("node -e");
      expect(error.message).not.toContain("\n");
    }
    // A real missing path still is one.
    const missing = agentErrorToControlError({
      code: ErrorCode.ERROR_CODE_NOT_FOUND,
      message: "not found: stat /workspace/missing: No such file or directory (os error 2)",
      retryable: false,
      detail: {},
    });
    expect(missing.processStartFailed).toBe(false);
    expect(missing.osNotFound).toBe(true);
  });

  test("tool output names the layer and what to do, not the script", () => {
    const error = spawnError("/bin/bash", " (the null device /dev/null is missing)");
    expect(selfhostedFaultClass(error)).toBe("process_start");
    expect(SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES.has("process_start")).toBe(true);
    const rendered = renderSelfhostedFault(error);
    expect(rendered).toContain("the machine could not start the program");
    expect(rendered).toContain("nothing ran; the command never started.");
    expect(rendered).toContain("Restart the machine");
    expect(renderSelfhostedFault(legacySpawnError(SCRIPT))).not.toContain("node -e");
  });
});

describe("compute restart", () => {
  test("the control client asks the control service to restart the box", async () => {
    const seen: Array<{ method: string; path: string; key: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          key: request.headers.get("x-api-key"),
        });
        return Response.json({ id: "sbx-1", host: null });
      },
    });
    try {
      const client = new ComputeControlClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "control-key",
        maxAttempts: 1,
      });
      await client.restart("sbx-1");
      expect(seen).toEqual([
        { method: "POST", path: "/v1/sandboxes/sbx-1/restart", key: "control-key" },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
