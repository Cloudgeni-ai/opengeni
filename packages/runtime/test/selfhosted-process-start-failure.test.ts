// A machine that cannot start programs: the agent's spawn error is reduced to
// the program it started (never the command text), is never a missing-path
// answer, renders actionable tool output, and a compute box can be restarted.

import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@opengeni/agent-proto";
import {
  ComputeControlClient,
  agentErrorToControlError,
  renderSelfhostedFault,
  sanitizeProcessStartFailureMessage,
  selfhostedFaultClass,
  SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES,
} from "../src/sandbox";
import { isDefinitePathNotFoundError } from "../src/sandbox/channel-a";

const SCRIPT = `node -e '\nconst fs = require("node:fs");\nthrow Error("Codemode client transfer integrity failure");\n' '/workspace/x.json'`;
const OS = "No such file or directory (os error 2)";

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
