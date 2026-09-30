import { describe, expect, test } from "bun:test";

describe("allowance admission lifecycle boundaries", () => {
  test("scheduled refusal retains the task's causal human and is visible before acceptance", async () => {
    const source = await Bun.file(
      new URL("../src/activities/scheduled-tasks.ts", import.meta.url),
    ).text();
    const human = source.indexOf("const causalHumanSubjectId =");
    const admission = source.indexOf(
      "const admissionDenial = await agentRunAdmissionDenial(",
      human,
    );
    const refused = source.indexOf(
      "return await refuseAdmission(admissionDenial, true,",
      admission,
    );
    const accepted = source.indexOf("const acceptedModel =", refused);
    expect(human).toBeGreaterThan(0);
    expect(admission).toBeGreaterThan(human);
    expect(refused).toBeGreaterThan(admission);
    expect(accepted).toBeGreaterThan(refused);
    expect(source.slice(admission, refused)).toContain(
      "initiatingHumanSubjectId: causalHumanSubjectId",
    );
    const recorder = source.indexOf("const refuseAdmission = async");
    expect(source.slice(recorder, human)).toContain("recordScheduledTaskAdmissionRefusal(db,");
    expect(source.slice(recorder, human)).toContain("producerKey: stableProducerKey");
  });

  test("goal refusal is applied through materialization without creating a continuation", async () => {
    const source = await Bun.file(new URL("../src/activities/goals.ts", import.meta.url)).text();
    const check = source.indexOf("const budgetBlocked = await goalRunBudgetBlocked(");
    const materialize = source.indexOf(
      "const decision = await materializeGoalContinuation(",
      check,
    );
    expect(check).toBeGreaterThan(0);
    expect(materialize).toBeGreaterThan(check);
    expect(source.slice(materialize, source.indexOf("policy:", materialize))).toContain(
      "budgetPausedReason:",
    );
    expect(source).toContain('return { pausedReason: "allowance",');
    expect(source).toContain(
      "agentRunAdmissionDenial(services, { ...input, requestedAgentRuns: 1 })",
    );
  });

  test("credit refusal is checked before core create and prompt persistence", async () => {
    const source = await Bun.file(
      new URL("../../../packages/core/src/domain/sessions.ts", import.meta.url),
    ).text();
    const create = source.indexOf("async function createSessionForRequestInFileScope(");
    const createGate = source.indexOf("await requireLimit(deps,", create);
    const createCommit = source.indexOf(
      "createOutcome = await createAndStartSessionWithOutcome(",
      createGate,
    );
    const prompt = source.indexOf("async function acceptSessionUserMessageInFileScope(");
    const promptGate = source.indexOf("await requireLimit(deps,", prompt);
    const promptCommit = source.indexOf("await postUserMessageTurn(", promptGate);
    expect(createGate).toBeGreaterThan(create);
    expect(createCommit).toBeGreaterThan(createGate);
    expect(promptGate).toBeGreaterThan(prompt);
    expect(promptCommit).toBeGreaterThan(promptGate);
    expect(source.slice(createGate, createCommit)).toContain("initiatingHumanSubjectId:");
    expect(source.slice(promptGate, promptCommit)).toContain("initiatingHumanSubjectId:");
    expect(source.slice(prompt, promptGate)).toContain(
      'delivery === "send" && input.expectedDraftRevision != null',
    );
    expect(source.slice(prompt, promptGate)).toContain("draft.sourceTurnId");
  });
});
