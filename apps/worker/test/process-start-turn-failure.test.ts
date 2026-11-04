import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import { ErrorCode } from "@opengeni/agent-proto";
import { agentErrorToControlError } from "@opengeni/runtime/sandbox";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";

// Regression for the 4 Nov incident: a compute box whose /dev/null was removed
// could not start programs, and its agent (up to 0.1.150) put the whole
// Codemode client install script into the error, which the turn failure then
// showed to the person verbatim.
const INSTALL_SCRIPT = `node -e '
const fs = require('\\''node:fs'\\''), crypto = require('\\''node:crypto'\\'');
const transferred = fs.readFileSync(process.argv[1]);
if (crypto.createHash('\\''sha256'\\'').update(raw).digest('\\''hex'\\'') !== "f52d") throw Error('\\''Codemode client transfer integrity failure'\\'');
' '/workspace/.opengeni/codemode-clients/stage-1.json'`;

function processStartError(program: string) {
  return agentErrorToControlError({
    code: ErrorCode.ERROR_CODE_NOT_FOUND,
    message: `not found: spawn or apply execution containment for ${program}: No such file or directory (os error 2)`,
    retryable: false,
    detail: {},
  });
}

function inToolCall(error: unknown): Error {
  return new ToolCallError(`Failed to run function tools: ${String(error)}`, error as Error);
}

describe("a turn whose sandbox cannot start programs", () => {
  test("the agent's error never carries the command text", () => {
    const error = processStartError(INSTALL_SCRIPT);
    expect(error.processStartFailed).toBe(true);
    // A failed spawn is not a missing path the caller asked about.
    expect(error.osNotFound).toBe(false);
    expect(error.message).toBe(
      "not found: spawn or apply execution containment for a shell command: No such file or directory (os error 2)",
    );
    for (const leaked of ["node -e", "crypto", "integrity failure", "\n"]) {
      expect(error.message).not.toContain(leaked);
    }
  });

  test("the turn fails with short copy, never the raw script (the incident)", () => {
    // The lazy setup's Codemode client install failed inside the first tool call.
    const failure = agentRunFailurePayload(inToolCall(processStartError(INSTALL_SCRIPT)));
    expect(failure.code).toBe("sandbox_process_start_failed");
    expect(failure.retryable).toBe(false);
    expect(failure.error).toContain("can't start programs");
    for (const text of [failure.error, String(failure.detail ?? "")]) {
      expect(text).not.toContain("node -e");
      expect(text).not.toContain("Codemode client transfer integrity failure");
    }
    expect(failure.error.length).toBeLessThan(200);
  });

});
