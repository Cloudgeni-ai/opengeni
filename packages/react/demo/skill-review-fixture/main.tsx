import { createRoot } from "react-dom/client";
import type { SkillRecord, SubmitHumanInputResponseRequest } from "@opengeni/sdk";
import { HumanInputForm } from "../../src/components/human-input-form";
import "../styles.css";

const content =
  "# Review fixture\n\n" + "Exact Skill text 日本語 👩🏽‍💻. ".repeat(600) + "END_OF_SKILL";
const sibling = "<script>window.unexpectedExecution = true</script>\n" + "x".repeat(1000);
const reference = {
  sourceOperationId: "operation",
  skillId: "skill",
  revisionId: "revision",
  expectedRevisionId: null,
  expectedScopeVersion: 1,
};
const record: SkillRecord = {
  id: "skill",
  stableKey: "fixture",
  scope: "workspace",
  scopeVersion: 1,
  status: "proposed",
  activeRevisionId: null,
  revisionId: "revision",
  title: "Review fixture",
  description: null,
  contentHash: "fixture-hash",
  source: null,
  activationMode: "workspace_managed",
  pendingRevisionIds: ["revision"],
  files: [
    { path: "SKILL.md", content },
    { path: "scripts/helper.txt", content: sibling },
  ],
};
const state = { responses: [] as SubmitHumanInputResponseRequest[], content, sibling };
Object.assign(window, { skillReviewFixture: state });
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 8 }}>
    <HumanInputForm
      request={{
        id: "request",
        expiresAt: null,
        allowSkip: false,
        questions: [
          {
            id: "skill:revision",
            kind: "single_select",
            label: "Save this Skill?",
            prompt: "Save the exact files below?",
            required: true,
            allowOther: false,
            options: [
              { id: "save", label: "Save" },
              { id: "skip", label: "Don't save" },
            ],
            skillReview: reference,
          },
        ],
      }}
      loadSkillReview={async () => {
        if (new URLSearchParams(location.search).has("fail"))
          throw new Error("Preview unavailable");
        return record;
      }}
      onSubmit={async (response) => {
        state.responses.push(response);
      }}
    />
  </main>,
);
