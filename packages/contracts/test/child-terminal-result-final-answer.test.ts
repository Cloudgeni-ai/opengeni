import { describe, expect, test } from "bun:test";
import {
  CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES,
  SessionSystemUpdatePayload,
  childTerminalResultFinalAnswer,
  sessionSystemUpdateBatchHistoryItem,
} from "../src/index";

const childSessionId = "5e5a5b8e-7c1d-4a0e-9f33-2f4c1f6f0b11";
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("childTerminalResultFinalAnswer", () => {
  test("an answer at the bound is copied whole", () => {
    const output = "a".repeat(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES);
    expect(childTerminalResultFinalAnswer({ childSessionId, sequence: 9, output })).toEqual({
      sequence: 9,
      text: output,
      truncated: false,
      totalBytes: CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES,
    });
  });

  test("an answer one byte over keeps head and tail around an exact marker", () => {
    const output = `${"h".repeat(6_000)}${"t".repeat(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES - 5_999)}`;
    const answer = childTerminalResultFinalAnswer({ childSessionId, sequence: 9, output });
    expect(answer.truncated).toBe(true);
    expect(answer.totalBytes).toBe(bytes(output));
    expect(bytes(answer.text)).toBeLessThanOrEqual(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES);
    const marker = /\n\n\[\.\.\. (\d+) bytes of the final answer omitted here\. [^\]]+\]\n\n/.exec(
      answer.text,
    );
    expect(marker).not.toBeNull();
    const [head, tail] = answer.text.split(marker![0]);
    expect(output.startsWith(head!)).toBe(true);
    expect(output.endsWith(tail!)).toBe(true);
    expect(Number(marker![1])).toBe(bytes(output) - bytes(head!) - bytes(tail!));
    expect(answer.nextAction).toEqual({
      tool: "session_events",
      arguments: { sessionId: childSessionId, view: "results", after: 8 },
    });
  });

  test("never splits a multi-byte character or a surrogate pair", () => {
    for (const unit of ["é", "😀", "中", "\ud800", "\udc00"]) {
      const output = unit.repeat(9_000);
      const answer = childTerminalResultFinalAnswer({ childSessionId, sequence: 1, output });
      expect(answer.truncated).toBe(true);
      expect(bytes(answer.text)).toBeLessThanOrEqual(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES);
      const [head, tail] = answer.text.split(/\n\n\[\.\.\. \d+ bytes[^\]]+\]\n\n/);
      expect(head!.length % unit.length).toBe(0);
      expect(tail!.length % unit.length).toBe(0);
      expect(head).toBe(unit.repeat(head!.length / unit.length));
      expect(tail).toBe(unit.repeat(tail!.length / unit.length));
    }
  });

  test("the typed payload stays optional and survives parse and model rendering", () => {
    const legacy = { type: "child_terminal_result", childSessionId, status: "idle" } as const;
    expect(SessionSystemUpdatePayload.parse(legacy)).toEqual(legacy);
    const finalAnswer = childTerminalResultFinalAnswer({
      childSessionId,
      sequence: 4,
      output: "The migration is complete.",
    });
    const payload = SessionSystemUpdatePayload.parse({ ...legacy, finalAnswer });
    const history = sessionSystemUpdateBatchHistoryItem([
      {
        id: "6b1c3b7e-6f1e-4c6e-8f0e-0e1f2a3b4c5d",
        kind: "child_terminal_result",
        classification: "success",
        sourceId: childSessionId,
        summary: "A worker session you spawned has finished its work and gone idle.",
        payload,
        lineage: {},
      },
    ]);
    const rendered = JSON.parse(history.content.slice(history.content.indexOf("{")));
    expect(rendered.updates[0].payload.finalAnswer).toEqual(finalAnswer);
  });
});
