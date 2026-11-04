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

function spawnError(program: string, note = "", code = ErrorCode.ERROR_CODE_NOT_FOUND) {
  return agentErrorToControlError({
    code,
    message: `not found: spawn or apply execution containment for ${program}${note}: ${OS}`,
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

  test("a program name and a newer agent's null-device note are kept", () => {
    expect(
      sanitizeProcessStartFailureMessage(
        `spawn or apply execution containment for /bin/bash (the null device /dev/null is missing): ${OS}`,
      ),
    ).toBe(
      `spawn or apply execution containment for /bin/bash (the null device /dev/null is missing): ${OS}`,
    );
    expect(
      sanitizeProcessStartFailureMessage(`spawn or apply execution containment for git: ${OS}`),
    ).toBe(`spawn or apply execution containment for git: ${OS}`);
  });

  test("sanitizing is idempotent and leaves other messages alone", () => {
    const once = sanitizeProcessStartFailureMessage(
      `spawn or apply execution containment for ${SCRIPT}: ${OS}`,
    );
    expect(sanitizeProcessStartFailureMessage(once)).toBe(once);
    expect(sanitizeProcessStartFailureMessage("exit status 1")).toBe("exit status 1");
  });

  test("command text that is not a plain program name is never kept", () => {
    // An old agent's short shell command with a secret and no spaces.
    const leaked = sanitizeProcessStartFailureMessage(
      `spawn or apply execution containment for TOKEN=sk-live-abc123;curl: ${OS}`,
    );
    expect(leaked).toBe(`spawn or apply execution containment for a shell command: ${OS}`);
    expect(leaked).not.toContain("sk-live");
  });

  test("a program name keeps the rest of the agent's message on one line", () => {
    expect(
      sanitizeProcessStartFailureMessage(
        "spawn or apply execution containment for /bin/sh: run_as requires Linux",
      ),
    ).toBe("spawn or apply execution containment for /bin/sh: run_as requires Linux");
    expect(
      sanitizeProcessStartFailureMessage(
        "spawn or apply execution containment for /bin/sh: write /sys/fs/cgroup/op-1/cgroup.procs:\nPermission denied (os error 13)",
      ),
    ).toBe(
      "spawn or apply execution containment for /bin/sh: write /sys/fs/cgroup/op-1/cgroup.procs: Permission denied (os error 13)",
    );
  });

  test("only a machine that cannot start programs is flagged; one missing program is a missing path", () => {
    const missing = spawnError("/nonexistent/opengeni-missing-program");
    expect(missing.processStartFailed).toBe(false);
    expect(missing.osNotFound).toBe(true);
    expect(selfhostedFaultClass(missing)).toBe("not_found");
    const denied = spawnError("/usr/local/bin/tool", "", ErrorCode.ERROR_CODE_OS);
    expect(denied.processStartFailed).toBe(false);
    const exhausted = agentErrorToControlError({
      code: ErrorCode.ERROR_CODE_OS,
      message:
        "spawn or apply execution containment for /bin/sh: Resource temporarily unavailable (os error 11)",
      retryable: false,
      detail: { errno: "11" },
    });
    expect(exhausted.processStartFailed).toBe(true);
    expect(spawnError("/bin/bash", " (the null device /dev/null is missing)").processStartFailed).toBe(
      true,
    );
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
      const error = spawnError(SCRIPT, "", code);
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
    expect(renderSelfhostedFault(spawnError(SCRIPT))).not.toContain("node -e");
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
