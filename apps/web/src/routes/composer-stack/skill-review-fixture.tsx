// The production session Skill review card for /dev/composer-stack, fed by a
// fixture client: `?skill=new|update|remove`. Approving or declining settles the fixture.
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { SessionSkillReviews } from "@opengeni/react/app/components/session/session-skill-reviews";
import type { SkillRecord } from "@opengeni/sdk";
import { useMemo } from "react";

export type SkillReviewPreview = "new" | "update" | "remove";

export function previewSkillReview(): SkillReviewPreview | null {
  const value = new URLSearchParams(window.location.search).get("skill");
  return value === "new" || value === "update" || value === "remove" ? value : null;
}

const DESCRIPTION =
  "Use when writing release notes or a changelog entry. Lead with what changed for people using the product, then any action they need to take.";

const SKILL_MD = `---
name: release-notes-style
description: ${DESCRIPTION}
---

# Release notes

1. Start with the change people will notice, in one sentence.
2. Say what they need to do, if anything.
3. Link the pull request or issue for details.
`;

function fixtureSkill(kind: SkillReviewPreview): SkillRecord {
  const revisionId = "33333333-3333-4333-8333-333333333333";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    revisionId,
    activeRevisionId: kind === "new" ? null : "44444444-4444-4444-8444-444444444444",
    scopeVersion: 1,
    scope: "user",
    activationMode: "workspace_managed",
    pendingRevisionIds: [revisionId],
    status: kind === "new" ? "proposed" : "active",
    title: "release-notes-style",
    description: DESCRIPTION,
    stableKey: "release-notes-style",
    contentHash: null,
    source: null,
    ...(kind === "remove" ? { removalOperationId: "11111111-1111-4111-8111-111111111111" } : {}),
    files: [{ path: "SKILL.md", content: SKILL_MD }],
  } as SkillRecord;
}

export function PreviewSkillReview({ kind }: { kind: SkillReviewPreview }) {
  const context = useMemo(() => {
    const skill = fixtureSkill(kind);
    let decided = false;
    const decide = (receipt: object) => async () => {
      decided = true;
      return receipt;
    };
    return {
      authSession: {},
      accessContext: { subjectId: "preview-user", workspaceGrants: [], accountGrants: [] },
      client: {
        listWorkspaceSkills: async () => ({ skills: decided ? [] : [skill], nextCursor: null }),
        readWorkspaceSkill: async () => skill,
        approveWorkspaceSkill: decide({ outcome: "applied" }),
        // The server preserves a rejected revision rather than applying it.
        rejectWorkspaceSkill: decide({ outcome: "preserved", decision: "rejected" }),
      },
    } as unknown as AppContextValue;
  }, [kind]);
  return (
    <SessionSkillReviews
      context={context}
      workspaceId="preview-workspace"
      sessionId="preview-session"
      events={[]}
    />
  );
}
