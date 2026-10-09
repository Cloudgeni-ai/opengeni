import { describe, expect, test } from "bun:test";

import {
  agentRunFailurePayload,
  providerRecoveryResult,
} from "../src/activities/agent-turn/errors";
import {
  AssistantOutputConformanceGuard,
  detectLeakedAgentTranscript,
  ProviderOutputProtocolViolationError,
} from "../src/activities/agent-turn/output-conformance";

const LEAKED_TRANSCRIPT = [
  "I’ll inspect the deployment first.",
  "[Assistant to=functions.exec_command]",
  '{"cmd":"git status"}',
  "[Tool/analysis]",
  "Chunk ID: 123",
  "[Assistant/analysis]",
  "The command succeeded.",
  "[Assistant final]",
  "Everything is fine.",
].join("\n");

describe("assistant output conformance", () => {
  test("detects a rendered agent/tool transcript", () => {
    expect(detectLeakedAgentTranscript(LEAKED_TRANSCRIPT)).toEqual({
      markers: ["assistant_tool_target", "tool_result", "assistant_internal"],
    });
  });

  test("does not reject ordinary prose or an isolated documentation marker", () => {
    expect(detectLeakedAgentTranscript("Deployment completed successfully.")).toBeNull();
    expect(
      detectLeakedAgentTranscript(
        "A protocol example may begin with:\n[Assistant to=functions.exec_command]",
      ),
    ).toBeNull();
    expect(
      detectLeakedAgentTranscript(
        "Inline text such as [Assistant to=functions.exec_command] and [Tool/analysis] is prose.",
      ),
    ).toBeNull();
  });

  test("quarantines markers split across deltas before reporting a violation", () => {
    const guard = new AssistantOutputConformanceGuard();
    const released: string[] = [];
    let violation = null;

    for (const delta of [
      "I’ll inspect the deployment first.\n[Assis",
      'tant to=functions.exec_command]\n{"cmd":"git status"}\n[To',
      "ol/analysis]\nChunk ID: 123",
    ]) {
      const guarded = guard.push(delta);
      released.push(guarded.text);
      violation = guarded.violation ?? violation;
    }

    expect(violation).not.toBeNull();
    expect(released.join("")).not.toContain("[Assistant to=");
    expect(released.join("")).not.toContain("[Tool/analysis]");
  });

  test("preserves safe streamed text exactly when the message finishes", () => {
    const guard = new AssistantOutputConformanceGuard();
    const input = "A normal answer streamed across several provider deltas.";
    const output = [guard.push(input.slice(0, 17)).text, guard.push(input.slice(17)).text];
    const finished = guard.finish();

    expect(finished.violation).toBeNull();
    expect([...output, finished.text].join("")).toBe(input);
  });

  test("allows bounded same-turn recovery only before structured tool activity", () => {
    const violation = detectLeakedAgentTranscript(LEAKED_TRANSCRIPT)!;
    const safeToRetry = new ProviderOutputProtocolViolationError(violation, false);
    const unsafeToRetry = new ProviderOutputProtocolViolationError(violation, true);

    expect(agentRunFailurePayload(safeToRetry)).toMatchObject({
      code: "provider_output_protocol_violation",
      retryable: true,
    });
    expect(agentRunFailurePayload(unsafeToRetry)).toMatchObject({
      code: "provider_output_protocol_violation",
      retryable: false,
    });
    expect(
      providerRecoveryResult({
        failureCode: "provider_output_protocol_violation",
        attemptNumber: 1,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 2_000 });
  });
});
