import { describe, expect, test } from "bun:test";

import { RequestHumanInputToolInput } from "@opengeni/contracts";
import { HUMAN_INPUT_TOOL_NAME, serializeHumanInputRequests } from "../src/run-events";

// `confirm_company_profile_for_attempt` (migration 0324) accepts an answered
// `session_human_input_requests` row only when `request.questions` is jsonb-equal
// to the proposal's SQL-built `human_input->'questions'`. The row is persisted
// from `RequestHumanInputToolInput.parse(...)` (plus the stock always-Other
// normalization), so any future zod default or normalization that changes the
// parsed shape would silently make every confirmation unavailable. This test
// mirrors the frozen SQL prompt shape and fails loudly in that case.
const REVISION_ID = "00000000-0000-4000-8000-000000000001";
const CONTENT_HASH = "a".repeat(64);

function sqlBuiltPrompt(): unknown {
  return JSON.parse(
    JSON.stringify({
      questions: [
        {
          id: `company-profile:${REVISION_ID}`,
          kind: "single_select",
          prompt: "Activate this organization company profile and strategic goals?",
          label: "Company profile",
          helpText: `Revision 7; SHA-256 ${CONTENT_HASH}.\n\nIdentity: Acme builds reliable logistics software.\nMission: Make critical supply chains predictable.\nProducts:\n- control-tower: A real-time logistics control tower.\nCustomers:\n- (none)\nGoals:\n- (none)\nConstraints:\n- (none)`,
          options: [
            { id: "activate", label: "Activate" },
            { id: "skip", label: "Do not activate" },
          ],
          required: true,
          allowOther: true,
        },
      ],
      allowSkip: false,
    }),
  );
}

describe("company-profile confirmation prompt", () => {
  test("survives RequestHumanInputToolInput.parse and the persisted normalization unchanged", () => {
    const prompt = sqlBuiltPrompt() as { questions: unknown[]; allowSkip: false };
    // No zod default, coercion, or strip may alter the SQL-built shape.
    expect(RequestHumanInputToolInput.parse(prompt)).toEqual(prompt);
    // The worker persists exactly this parsed input (after the stock always-Other
    // normalization, which the SQL prompt already satisfies) as the durable
    // `session_human_input_requests.questions`.
    expect(
      serializeHumanInputRequests([
        {
          name: HUMAN_INPUT_TOOL_NAME,
          rawItem: {
            callId: "company-profile-confirmation:receipt",
            name: HUMAN_INPUT_TOOL_NAME,
            arguments: JSON.stringify(prompt),
          },
        },
      ]),
    ).toEqual([
      {
        toolCallId: "company-profile-confirmation:receipt",
        input: { questions: prompt.questions, allowSkip: false },
      },
    ]);
  });
});
