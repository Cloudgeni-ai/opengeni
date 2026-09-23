import { createRoot } from "react-dom/client";
import type { SkillRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { AppContextValue } from "../../../src/context";
import { SessionSkillReviews } from "../../../src/components/session/session-skill-reviews";
import "../../../src/styles.css";

const removing = new URLSearchParams(location.search).has("remove");
const fail = new URLSearchParams(location.search).has("fail");
const skill: SkillRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  revisionId: "33333333-3333-4333-8333-333333333333",
  activeRevisionId: null, scopeVersion: 1, scope: "user", activationMode: "workspace_managed",
  pendingRevisionIds: ["33333333-3333-4333-8333-333333333333"], status: "proposed",
  title: "Release checklist", description: "Verify releases", stableKey: "release-checklist", contentHash: null, source: null,
  ...(removing ? { removalOperationId: "11111111-1111-4111-8111-111111111111" } : {}),
  files: [
    { path: "SKILL.md", content: "---\nname: release-checklist\ndescription: Verify releases\n---\nReview the exact candidate and run targeted tests.\n<script>window.unexpectedExecution = true</script>" },
    { path: "references/checklist.txt", content: "Confirm CI, exact head, and rollback instructions." },
  ],
};
let approved = false;
const context = {
  authSession: {}, accessContext: { subjectId: "fixture-user", workspaceGrants: [], accountGrants: [] },
  client: {
    listWorkspaceSkills: async () => ({ skills: approved ? [] : [skill], nextCursor: null }),
    readWorkspaceSkill: async () => { if (fail) throw new OpenGeniApiError(503, "Unavailable"); return skill; },
    approveWorkspaceSkill: async (_workspaceId: string, _skillId: string, request: unknown) => {
      approved = true;
      (window as unknown as { approval: unknown }).approval = request;
      return { outcome: "applied" };
    },
  },
} as unknown as AppContextValue;
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl p-4">
    <h1 className="text-lg">Session Skill review</h1>
    <p className="text-sm">The chat continues while this Skill waits for your review.</p>
    <SessionSkillReviews context={context} workspaceId="workspace" sessionId="session" events={[]} />
    <textarea aria-label="Message" className="w-full rounded-lg border p-3" placeholder="Continue the conversation…" />
  </main>,
);