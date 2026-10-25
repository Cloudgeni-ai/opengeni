import { describe, expect, test } from "bun:test";
import {
  RequestHumanInputToolInput,
  SecretReferenceError,
  secretUseApprovalHumanInput,
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

  test("tool output gains approvalCard only when a use needs approval", () => {
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

    const card = secretUseApprovalHumanInput(view());
    const output = JSON.parse(
      new SecretReferenceError(
        [
          {
            raw: RAW,
            code: "approval_required",
            message: "needs approval",
          },
        ],
        null,
        card,
      ).toModelOutput(),
    );
    expect(Object.keys(output)).toEqual(["error", "failures", "askCard", "approvalCard", "hint"]);
    expect(output.approvalCard).toEqual(card);
    expect(output.hint).toContain("call request_human_input with approvalCard exactly as given");
  });
});
