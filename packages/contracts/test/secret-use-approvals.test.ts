import { describe, expect, test } from "bun:test";
import {
  RequestHumanInputToolInput,
  SecretReferenceError,
  secretUseApprovalHumanInput,
  secretUseApprovalDecisionSummary,
  secretUseApprovalIdFromQuestionId,
  secretUseApprovalQuestionId,
  type SecretUseApprovalRequestView,
} from "../src/index";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
// Built at runtime so tooling that expands references never sees one here.
const RAW = ["{", "{secret:GitHub/password}", "}"].join("");

function view(overrides: Partial<SecretUseApprovalRequestView> = {}): SecretUseApprovalRequestView {
  return {
    id: ID,
    targets: [
      {
        vaultId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        itemId: "16fd2706-8baf-433b-82eb-8c7fada847da",
        fieldKey: "password",
        vaultName: "Private",
        itemName: "GitHub",
        fieldName: "password",
      },
    ],
    surface: "browser",
    toolName: "browser_act",
    destination: "github.com",
    ...overrides,
  };
}

describe("secret approval card", () => {
  test("names the item, field and destination and offers exactly the four choices", () => {
    const card = secretUseApprovalHumanInput(view());
    expect(RequestHumanInputToolInput.safeParse(card).success).toBe(true);
    expect(card.allowSkip).toBe(false);
    const [question] = card.questions;
    expect(question?.id).toBe(`secret-approval:${ID}`);
    expect(question?.prompt).toBe(
      "Allow the agent to use GitHub › password in the browser on github.com?",
    );
    expect(question?.helpText).toContain("the Private vault");
    expect(question?.helpText).toContain("never to the agent");
    expect(question?.allowOther).toBe(false);
    expect(question?.options.map((option) => option.id)).toEqual([
      "once",
      "session",
      "window",
      "deny",
    ]);
  });

  test("describes several fields, whole items and unknown destinations plainly", () => {
    const base = view().targets[0]!;
    const card = secretUseApprovalHumanInput(
      view({
        targets: [
          { ...base, fieldKey: "username", fieldName: "username" },
          base,
          { ...base, itemId: ID, itemName: "Deploy key", fieldKey: "", fieldName: "" },
        ],
        surface: "run_on",
        toolName: "run_on",
        destination: null,
      }),
    );
    expect(card.questions[0]?.prompt).toBe(
      "Allow the agent to use GitHub › username, GitHub › password and Deploy key on another machine?",
    );
    const unknownSurface = secretUseApprovalHumanInput(
      view({ surface: "something_new", toolName: "fancy_tool", destination: null }),
    );
    expect(unknownSurface.questions[0]?.prompt).toEndWith("with fancy_tool?");
  });

  test("binds question ids to request ids and nothing else", () => {
    expect(secretUseApprovalIdFromQuestionId(secretUseApprovalQuestionId(ID))).toBe(ID);
    expect(secretUseApprovalIdFromQuestionId(`secret-approval:${ID.toUpperCase()}`)).toBe(ID);
    expect(secretUseApprovalIdFromQuestionId("secret-approval:not-a-uuid")).toBeNull();
    expect(secretUseApprovalIdFromQuestionId(`secret-approval:${ID}x`)).toBeNull();
    expect(secretUseApprovalIdFromQuestionId(ID)).toBeNull();
    expect(secretUseApprovalIdFromQuestionId("environment")).toBeNull();
  });

  test("tool output says the person was asked and never carries the card", () => {
    const failures = [
      {
        raw: RAW,
        code: "not_found" as const,
        message: "no GitHub item",
      },
    ];
    // Without a card the output keeps the exact earlier shape and text.
    expect(new SecretReferenceError(failures).toModelOutput()).toBe(
      JSON.stringify({
        error: "secret_reference_error",
        failures,
        askCard: null,
        hint: "Nothing was run. See each failure's message.",
      }),
    );

    const blocked = [
      {
        raw: RAW,
        code: "approval_required" as const,
        message: "needs approval",
      },
    ];
    const output = JSON.parse(
      new SecretReferenceError(blocked, null, { approvalId: ID, asked: true }).toModelOutput(),
    );
    expect(Object.keys(output)).toEqual(["error", "failures", "askCard", "hint"]);
    expect(output.askCard).toBeNull();
    expect(output.hint).toBe(
      "Nothing was run. Opengeni has asked the person, in this chat and by notification, to allow this use of the secret; do not ask them yourself. Their answer reaches you as an update in this chat after this turn: if they allow it, retry the same call then; if they deny it, do not retry. Until then, continue with other work or end your turn.",
    );
    expect(output.hint).not.toContain("request_human_input");
    expect(JSON.stringify(output)).not.toContain(ID);

    const unasked = JSON.parse(
      new SecretReferenceError(blocked, null, { approvalId: ID, asked: false }).toModelOutput(),
    );
    expect(unasked.hint).toBe(
      "Nothing was run. The person must allow each use of this secret, and this run could not ask them. Tell them the use is waiting for their approval.",
    );
  });

  test("decision summaries tell the agent whether to retry, by name only", () => {
    expect(secretUseApprovalDecisionSummary(view(), "once")).toBe(
      "The person allowed using GitHub › password in the browser on github.com (browser_act) once. Nothing ran when it was blocked: retry that same call now, unless a retry already succeeded after they answered.",
    );
    expect(secretUseApprovalDecisionSummary(view(), "session")).toContain(
      "for the rest of this chat. Nothing ran",
    );
    expect(secretUseApprovalDecisionSummary(view(), "window")).toContain(
      "for 1 hour in their chats in this workspace.",
    );
    const denied = secretUseApprovalDecisionSummary(view(), "deny");
    expect(denied).toBe(
      "The person denied using GitHub › password in the browser on github.com (browser_act). Do not retry that call; continue without it or ask them what to do instead.",
    );
    expect(denied).not.toContain("16fd2706");
  });
});
