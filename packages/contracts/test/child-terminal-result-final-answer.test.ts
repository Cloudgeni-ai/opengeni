import { describe, expect, test } from "bun:test";
import {
  CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES,
  SessionSystemUpdatePayload,
  childTerminalResultFinalAnswer,
  childTerminalResultFinalAnswerSequences,
  childTerminalResultFinalAnswerWithGoalContinuations,
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

describe("childTerminalResultFinalAnswerWithGoalContinuations", () => {
  const answer = "28 distinct users submitted work in the window.";
  const remark = "The goal is complete. A fresh check confirmed the 28 users.";

  test("keeps the answer and appends each continuation whole, oldest first", () => {
    const result = childTerminalResultFinalAnswerWithGoalContinuations({
      childSessionId,
      sequence: 7,
      output: answer,
      goalContinuations: [
        { sequence: 9, output: remark },
        { sequence: 11, output: "" },
        { sequence: 13, output: "Still complete." },
      ],
    });
    expect(result).toEqual({
      sequence: 7,
      text: answer,
      truncated: false,
      totalBytes: bytes(answer),
      goalContinuations: [
        { sequence: 9, text: remark },
        { sequence: 13, text: "Still complete." },
      ],
    });
    const payload = SessionSystemUpdatePayload.parse({
      type: "child_terminal_result",
      childSessionId,
      status: "idle",
      finalAnswer: result,
    });
    expect(payload).toMatchObject({ finalAnswer: result });
  });

  test("without continuation output it is the ordinary bounded answer", () => {
    const output = "a".repeat(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES + 1);
    expect(
      childTerminalResultFinalAnswerWithGoalContinuations({
        childSessionId,
        sequence: 7,
        output,
        goalContinuations: [{ sequence: 9, output: "" }],
      }),
    ).toEqual(childTerminalResultFinalAnswer({ childSessionId, sequence: 7, output }));
  });

  test("copies the parts whole only while together they fit the bound", () => {
    const half = CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES / 2;
    const fits = childTerminalResultFinalAnswerWithGoalContinuations({
      childSessionId,
      sequence: 7,
      output: "a".repeat(half),
      goalContinuations: [{ sequence: 9, output: "b".repeat(half) }],
    });
    expect(fits.truncated).toBe(false);
    expect(childTerminalResultFinalAnswerSequences(fits)).toEqual([7, 9]);
  });

  test("over the bound, keeps the newest part whole and points at every part", () => {
    const start = "Starting the audit.";
    const progress = "p".repeat(4_600);
    const report = `FINAL REPORT\n${"r".repeat(3_600)}`;
    const result = childTerminalResultFinalAnswerWithGoalContinuations({
      childSessionId,
      sequence: 7,
      output: start,
      goalContinuations: [
        { sequence: 9, output: progress },
        { sequence: 11, output: report },
      ],
    });
    const lead =
      /^\[\.\.\. (\d+) bytes of earlier output from this child \(2 turns\) omitted here\. [^\]]+\]\n\n/.exec(
        result.text,
      );
    expect(lead).not.toBeNull();
    expect(Number(lead![1])).toBe(bytes(start) + bytes(progress));
    expect(result.text.slice(lead![0].length)).toBe(report);
    expect(bytes(result.text)).toBeLessThanOrEqual(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES);
    expect(result).toMatchObject({
      sequence: 11,
      truncated: true,
      totalBytes: bytes(start) + bytes(progress) + bytes(report),
      omittedSequences: [7, 9],
      nextAction: {
        tool: "session_events",
        arguments: { sessionId: childSessionId, view: "results", after: 6 },
      },
    });
    expect(result.goalContinuations).toBeUndefined();
    expect(childTerminalResultFinalAnswerSequences(result)).toEqual([11, 7, 9]);
    expect(
      SessionSystemUpdatePayload.parse({
        type: "child_terminal_result",
        childSessionId,
        status: "idle",
        finalAnswer: result,
      }),
    ).toMatchObject({ finalAnswer: result });
  });

  test("cuts a newest part that alone exceeds the bound, UTF-8 safely", () => {
    const newest = `${"h".repeat(5_000)}${"😀".repeat(2_000)}`;
    const result = childTerminalResultFinalAnswerWithGoalContinuations({
      childSessionId,
      sequence: 7,
      output: "The answer.",
      goalContinuations: [{ sequence: 9, output: newest }],
    });
    expect(result.truncated).toBe(true);
    expect(result.sequence).toBe(9);
    expect(result.omittedSequences).toEqual([7]);
    expect(bytes(result.text)).toBeLessThanOrEqual(CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES);
    const body = result.text.replace(
      /^\[\.\.\. 11 bytes of earlier output from this child \(1 turn\)[^\]]+\]\n\n/,
      "",
    );
    expect(body).not.toBe(result.text);
    const marker = /\n\n\[\.\.\. (\d+) bytes of this output omitted here\. [^\]]+\]\n\n/.exec(body);
    expect(marker).not.toBeNull();
    const [head, tail] = body.split(marker![0]);
    expect(newest.startsWith(head!)).toBe(true);
    expect(newest.endsWith(tail!)).toBe(true);
    expect(Number(marker![1])).toBe(bytes(newest) - bytes(head!) - bytes(tail!));
  });
});
