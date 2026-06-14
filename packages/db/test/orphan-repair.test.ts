import { describe, expect, test } from "bun:test";
import { orphanedResultRowIndicesForRepair } from "../src/index";

// Pure spec for migration 0014 (repair of legacy orphaned tool-call results).
// orphanedResultRowIndicesForRepair() mirrors the migration's SQL WHERE clause:
// over a session's ACTIVE rows in position order, it returns the indices of the
// orphaned RESULT rows the repair deletes — exactly the session-bricking rows
// the Responses API 400s on ("No tool call found for function call output").

function row(item: Record<string, unknown>) {
  return { item };
}
function userMessage(text: string) {
  return { type: "message", role: "user", content: text };
}
function functionCall(callId: string) {
  return { type: "function_call", callId, name: "tool", arguments: "{}" };
}
function functionResult(callId: string) {
  return { type: "function_call_result", callId, output: { type: "text", text: "ok" } };
}

describe("orphanedResultRowIndicesForRepair (migration 0014 spec)", () => {
  test("flags a function_call_result with no preceding function_call (the brick)", () => {
    const rows = [
      row(userMessage("hi")),
      row(functionResult("orphan")), // index 1 — orphan, no call before it
      row(userMessage("bye")),
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([1]);
  });

  test("keeps a properly paired call+result (call strictly earlier)", () => {
    const rows = [
      row(functionCall("c1")),
      row(functionResult("c1")), // paired — kept
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([]);
  });

  test("a result BEFORE its call is still an orphan (ordering enforced)", () => {
    const rows = [
      row(functionResult("c1")), // index 0 — call appears later, so this is an orphan
      row(functionCall("c1")),
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([0]);
  });

  test("does NOT flag a dangling call (call with no result yet — valid, not corruption)", () => {
    const rows = [
      row(userMessage("go")),
      row(functionCall("pending")), // dangling but valid mid-turn — untouched
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([]);
  });

  test("matches snake_case call_id as well as camelCase callId", () => {
    const rows = [
      row({ type: "function_call", call_id: "snake" }),
      row({ type: "function_call_result", call_id: "snake" }), // paired via snake_case — kept
      row({ type: "function_call_result", call_id: "missing" }), // index 2 — orphan
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([2]);
  });

  test("covers every result/call type pair the SDK can emit", () => {
    const rows = [
      // orphans (no preceding call)
      row({ type: "computer_call_result", callId: "cc" }),       // 0 orphan
      row({ type: "shell_call_output", callId: "sh" }),          // 1 orphan
      row({ type: "apply_patch_call_output", callId: "ap" }),    // 2 orphan
      // paired
      row({ type: "shell_call", callId: "ok" }),                 // 3 call
      row({ type: "shell_call_output", callId: "ok" }),          // 4 result — kept
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([0, 1, 2]);
  });

  test("multiple orphans interleaved with valid pairs", () => {
    const rows = [
      row(functionResult("orphan_a")), // 0 orphan
      row(functionCall("good")),
      row(functionResult("good")),     // paired — kept
      row(functionResult("orphan_b")), // 3 orphan
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([0, 3]);
  });

  test("existence semantics: a duplicate result is NOT deleted while its call still exists earlier", () => {
    // The repair is conservative — it deletes a result only when NO earlier
    // matching call exists (matching the migration's NOT EXISTS). A second result
    // re-using an already-settled call_id is left on disk because the call is
    // still present before it; the read-path sanitizer drops the rare duplicate
    // in-memory, so the model request is valid regardless. The repair must never
    // delete a row whose call exists.
    const rows = [
      row(functionCall("c1")),
      row(functionResult("c1")),
      row(functionResult("c1")), // duplicate, but a matching call exists earlier — kept
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([]);
  });

  test("ignores non-tool rows and items without a correlation id", () => {
    const rows = [
      row(userMessage("a")),
      row({ type: "reasoning", id: "rs_1" }),
      row({ type: "function_call_result" }), // no call_id — cannot correlate; left alone
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([]);
  });

  test("clean history yields no deletions", () => {
    const rows = [
      row(userMessage("hi")),
      row(functionCall("c1")),
      row(functionResult("c1")),
      row(userMessage("bye")),
    ];
    expect(orphanedResultRowIndicesForRepair(rows)).toEqual([]);
  });
});
