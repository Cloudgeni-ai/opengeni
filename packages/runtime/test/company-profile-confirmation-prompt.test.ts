import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
  test("mirrors the frozen SQL prompt shape byte for byte", async () => {
    const migration = await readFile(
      new URL(
        "../../db/drizzle/0324_human_confirmed_company_profile_agent_admin.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const body = migration.slice(
      migration.indexOf("CREATE FUNCTION company_profile_agent_confirmation_prompt("),
      migration.indexOf("CREATE FUNCTION propose_company_profile_for_attempt("),
    );
    for (const fragment of [
      "'id', 'company-profile:' || p_revision_id::text",
      "'kind', 'single_select'",
      "'prompt', 'Activate this organization company profile and strategic goals?'",
      "'label', 'Company profile'",
      "'helpText', 'Revision ' || p_revision::text || '; SHA-256 ' || p_content_hash",
      "|| E'.\\n\\n' || company_profile_agent_confirmation_summary(p_content_json)",
      "jsonb_build_object('id', 'activate', 'label', 'Activate')",
      "jsonb_build_object('id', 'skip', 'label', 'Do not activate')",
      "'required', true",
      "'allowOther', true",
      "'allowSkip', false",
    ]) {
      expect(body).toContain(fragment);
    }
    const questionKeys = [...body.matchAll(/^ {6}'(\w+)', /gm)].map((match) => match[1]);
    expect(questionKeys).toEqual([
      "id",
      "kind",
      "prompt",
      "label",
      "helpText",
      "options",
      "required",
      "allowOther",
    ]);
    const prompt = sqlBuiltPrompt() as { questions: Array<Record<string, unknown>> };
    expect(Object.keys(prompt.questions[0]!)).toEqual(questionKeys);
  });

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
