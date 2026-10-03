import { describe, expect, test } from "bun:test";
import {
  parseSync,
  visitorKeys,
  type CallExpression,
  type FunctionDeclaration,
  type Node,
} from "oxc-parser";

function creditAdmissionBoundary(
  source: string,
  functionName: string,
  persistenceName: string,
  frozenInitiatorName: string,
) {
  const parsed = parseSync("sessions.ts", source);
  if (parsed.errors.length) throw new Error("invalid admission source");
  const declaration = parsed.program.body.find(
    (node): node is FunctionDeclaration =>
      node.type === "FunctionDeclaration" && node.id?.name === functionName,
  );
  if (!declaration?.body) throw new Error(`missing function ${functionName}`);
  const gates: CallExpression[] = [];
  const persistence: CallExpression[] = [];
  const parents = new WeakMap<Node, Node>();
  const visit = (node: Node, parent?: Node): void => {
    if (parent) parents.set(node, parent);
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      if (node.callee.name === "requireLimit") gates.push(node);
      if (node.callee.name === persistenceName) persistence.push(node);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child) visit(child as Node, node);
      } else if (value && typeof value === "object") {
        visit(value as Node, node);
      }
    }
  };
  visit(declaration.body);
  if (gates.length !== 1 || persistence.length !== 1) {
    throw new Error("expected exactly one credit gate and persistence call in this function");
  }
  const gate = gates[0]!;
  const commit = persistence[0]!;
  let awaitedGate: Node = gate;
  // The timing helper synchronously invokes its callback and returns its
  // promise. Its awaited call is the admission boundary, not the callback text.
  const gateParent = parents.get(gate);
  if (gateParent?.type === "ArrowFunctionExpression" && gateParent.body === gate) {
    const wrapper = parents.get(gateParent);
    if (
      wrapper?.type !== "CallExpression" ||
      wrapper.callee.type !== "Identifier" ||
      wrapper.callee.name !== "measureSessionStartPhase" ||
      wrapper.arguments[2] !== gateParent
    ) {
      throw new Error("credit gate must be awaited, not stored in a callback");
    }
    awaitedGate = wrapper;
  }
  if (parents.get(awaitedGate)?.type !== "AwaitExpression") {
    throw new Error("credit gate must be awaited");
  }
  if (parents.get(commit)?.type !== "AwaitExpression")
    throw new Error("persistence must be awaited");
  if (awaitedGate.start >= commit.start) {
    throw new Error("credit gate must precede persistence");
  }
  const input = gate.arguments[1];
  const human =
    input?.type === "ObjectExpression"
      ? input.properties.find(
          (property) =>
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            property.key.name === "initiatingHumanSubjectId",
        )
      : undefined;
  const causalHuman = human?.type === "Property" ? human.value : undefined;
  if (
    causalHuman?.type !== "CallExpression" ||
    causalHuman.callee.type !== "Identifier" ||
    causalHuman.callee.name !== "initiatingHumanForAllowance" ||
    causalHuman.arguments[0]?.type !== "Identifier" ||
    causalHuman.arguments[0].name !== frozenInitiatorName
  ) {
    throw new Error("credit gate must use the frozen causal initiator");
  }
  return { declaration, gate };
}

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
    const materialize = source.indexOf("const decision = await materializeGoalContinuation(");
    const check = source.indexOf("admission: async (tx, causalTurn)", materialize);
    expect(materialize).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(materialize);
    expect(source.slice(materialize, source.indexOf("policy:", materialize))).toContain(
      "budgetPausedReason:",
    );
    expect(source).toContain('return { pausedReason: "allowance",');
    expect(source).toContain(
      "agentRunAdmissionDenial(services, { ...input, requestedAgentRuns: 1 })",
    );
    expect(source).toContain(
      "initiatingHumanSubjectId: causalTurn?.initiatingHumanSubjectId ?? null",
    );
  });

  test("credit refusal is checked before core create and prompt persistence", async () => {
    const source = await Bun.file(
      new URL("../../../packages/core/src/domain/sessions.ts", import.meta.url),
    ).text();
    creditAdmissionBoundary(
      source,
      "createSessionForRequestInFileScope",
      "createAndStartSessionWithOutcome",
      "frozenCreationInitiator",
    );
    const prompt = creditAdmissionBoundary(
      source,
      "acceptSessionUserMessageInFileScope",
      "postUserMessageTurn",
      "frozenAdmissionInitiator",
    );
    const beforePromptGate = source.slice(prompt.declaration.start, prompt.gate.start);
    expect(beforePromptGate).toContain(
      'delivery === "send" && input.expectedDraftRevision != null',
    );
    expect(beforePromptGate).toContain("draft.sourceTurnId");
  });

  test("the structured guard accepts awaited direct and timing-wrapped credit checks", () => {
    const gate =
      "requireLimit(deps, { initiatingHumanSubjectId: initiatingHumanForAllowance(frozen) })";
    for (const statement of [
      `await ${gate};`,
      `await measureSessionStartPhase(observer, "allowance", () => ${gate});`,
    ]) {
      expect(() =>
        creditAdmissionBoundary(
          `async function admission() { ${statement} await persist({}); }`,
          "admission",
          "persist",
          "frozen",
        ),
      ).not.toThrow();
    }
  });

  test("the structured guard rejects misplaced, missing, unawaited and borrowed credit gates", () => {
    const gate =
      "requireLimit(deps, { initiatingHumanSubjectId: initiatingHumanForAllowance(frozen) })";
    for (const [body, message] of [
      [`await persist({}); await ${gate};`, "credit gate must precede persistence"],
      ["await persist({});", "expected exactly one credit gate"],
      [`${gate}; await persist({});`, "credit gate must be awaited"],
      [`const later = () => ${gate}; await persist({});`, "credit gate must be awaited"],
      [
        `measureSessionStartPhase(observer, "allowance", () => ${gate}); await persist({});`,
        "credit gate must be awaited",
      ],
      [
        "await requireLimit(deps, { initiatingHumanSubjectId: grant.subjectId }); await persist({});",
        "credit gate must use the frozen causal initiator",
      ],
    ]) {
      expect(() =>
        creditAdmissionBoundary(
          `async function unrelated() { await ${gate}; }
           async function admission() { ${body} }`,
          "admission",
          "persist",
          "frozen",
        ),
      ).toThrow(message);
    }
  });
});
