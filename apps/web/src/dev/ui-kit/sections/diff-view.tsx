import { useState } from "react";

import { Button } from "@/components/ui/button";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { DiffView, type DiffViewVariant } from "@/components/ui/diff-view";
import { MetaChip } from "@/components/ui/meta-chip";
import { formatDate } from "@/components/ui/relative-time";
import { RevisionHistory, type Revision } from "@/components/ui/revision-history";
import { KIT_NOW, KIT_TIME_ZONE, reviewItems, workspaceInstructions } from "../fixtures";
import { KitBlock, KitCanvas, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

const draftPrs = reviewItems.find((item) => item.id === "review-draft-prs")!;
const residency = reviewItems.find((item) => item.id === "review-eu-residency")!;
const newSkill = reviewItems.find((item) => item.id === "review-release-notes")!;

/** The two saved versions of Design preview's instructions, newest first. */
const INSTRUCTION_REVISIONS: Revision[] = [
  {
    id: workspaceInstructions.revisions[0]!.id,
    author: workspaceInstructions.revisions[0]!.author,
    createdAt: "2026-09-23T09:14:00Z",
    summary: workspaceInstructions.revisions[0]!.summary,
    content: workspaceInstructions.revisions[0]!.markdown,
  },
  {
    id: workspaceInstructions.revisions[1]!.id,
    author: workspaceInstructions.revisions[1]!.author,
    createdAt: "2026-09-18T07:40:00Z",
    summary: workspaceInstructions.revisions[1]!.summary,
    content: workspaceInstructions.revisions[1]!.markdown,
  },
];

/** A longer instructions document, to show collapsed context. */
const LONG_BEFORE = [
  "## How we work",
  "",
  "- Production changes need a second reviewer.",
  "- Prefer small PRs.",
  "- Link the Linear issue in every pull request.",
  "- Write the PR description for someone who wasn't in the chat.",
  "",
  "## Releases",
  "",
  "- Cut releases from main on Tuesdays and Thursdays.",
  "- Staging must be green for 30 minutes before a release.",
  "- Post the release notes in #releases.",
  "",
  "## On call",
  "",
  "- Page the platform on-call for anything customer facing.",
  "- Datadog monitors in eu-north-1 are the source of truth.",
  "- Write a short incident note within 24 hours.",
].join("\n");
const LONG_AFTER = LONG_BEFORE.replace(
  "- Staging must be green for 30 minutes before a release.",
  "- Staging must be green for 60 minutes before a release, including the smoke tests.",
);

/** The kind as a chip, then where it came from as a link (brief: Knowledge review). */
function ReviewMeta({
  kindLabel,
  origin,
  createdLabel,
}: {
  kindLabel: string;
  origin: { kind: "chat" | "schedule"; name: string };
  createdLabel: string;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <MetaChip variant="outline">{kindLabel}</MetaChip>
      <span className="min-w-0">
        From {origin.kind}{" "}
        <a
          href={`/dev/ui-kit?section=${origin.kind === "schedule" ? "page-schedules" : "page-knowledge"}`}
          className="rounded-[4px] font-medium text-fg underline-offset-2 hover:underline"
        >
          {origin.name}
        </a>{" "}
        · <span className="whitespace-nowrap">{createdLabel}</span>
      </span>
    </span>
  );
}

function ReviewPane() {
  const [state, setState] = useState<"pending" | "approved" | "rejected">("pending");
  const decided = state !== "pending";
  return (
    <DiffView
      lines={draftPrs.diff}
      title={draftPrs.title}
      meta={
        <ReviewMeta
          kindLabel={draftPrs.kindLabel}
          origin={draftPrs.origin}
          createdLabel={draftPrs.createdLabel}
        />
      }
      actions={
        decided ? (
          <span className="text-xs leading-4.5 font-medium text-fg-muted">
            {state === "approved" ? "Approved" : "Rejected"}
          </span>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="pointer-coarse:min-h-11"
              onClick={() => {
                setState("rejected");
                showUndoToast({
                  title: "Rejected the instruction change",
                  onUndo: () => setState("pending"),
                });
              }}
            >
              Reject
            </Button>
            <Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11">
              Edit first
            </Button>
            <Button
              type="button"
              size="sm"
              className="pointer-coarse:min-h-11"
              onClick={() => {
                setState("approved");
                showUndoToast({
                  title: "Added to workspace instructions",
                  onUndo: () => setState("pending"),
                });
              }}
            >
              Approve and next
            </Button>
          </>
        )
      }
    />
  );
}

function HistoryDemo({ layout }: { layout: "stacked" | "split" }) {
  const [revisions, setRevisions] = useState(INSTRUCTION_REVISIONS);
  return (
    <RevisionHistory
      layout={layout}
      label="Workspace instructions history"
      revisions={revisions}
      now={KIT_NOW}
      onRestore={async (revision) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const day = revision.createdAt
          ? formatDate(revision.createdAt, { now: KIT_NOW, timeZone: KIT_TIME_ZONE })
          : "an earlier version";
        const restored: Revision = {
          id: `restored-${revisions.length}`,
          author: "Bendik Hansen",
          createdAt: KIT_NOW.toISOString(),
          summary: `Restored the version from ${day}`,
          content: revision.content,
        };
        setRevisions((current) => [restored, ...current]);
        showUndoToast({
          title: `Restored the version from ${day}`,
          description: "It's now the current version.",
          onUndo: () =>
            setRevisions((current) => current.filter((each) => each.id !== restored.id)),
        });
      }}
    />
  );
}

const VARIANTS: Array<{ id: DiffViewVariant; label: string; note: string }> = [
  {
    id: "inline",
    label: "Inline (default)",
    note: "One column. The changed words are marked inside each line.",
  },
  {
    id: "split",
    label: "Split",
    note: "Before and after side by side, for longer rewrites. Stacks on narrow screens.",
  },
  {
    id: "prose",
    label: "Prose",
    note: "The text as it reads, for short knowledge entries.",
  },
];

export default function DiffViewSection() {
  return (
    <KitSection sectionKey="diff-view">
      <KitBlock
        title="An instruction change in review"
        description="The agent proposed a new workspace instruction from a schedule run. The reviewer sees exactly what changes before it goes into every prompt."
      >
        <ReviewPane />
      </KitBlock>

      <StatesGrid
        title="Variants"
        columns={1}
        description={`The same knowledge update, "${residency.title}", three ways.`}
      >
        {VARIANTS.map((variant) => (
          <StateCell key={variant.id} label={variant.label} note={variant.note} align="stretch">
            <DiffView
              variant={variant.id}
              lines={residency.diff}
              title={residency.title}
              meta={
                <ReviewMeta
                  kindLabel={residency.kindLabel}
                  origin={residency.origin}
                  createdLabel={residency.createdLabel}
                />
              }
            />
          </StateCell>
        ))}
      </StatesGrid>

      <KitBlock
        title="Revision history"
        description="Every saved version with what it changed. Restore saves the old text as the newest version, so it's undone with Undo instead of a dialog."
      >
        <div className="grid min-w-0 gap-6 @4xl/kit-section:grid-cols-[30rem_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs leading-4.5 font-medium text-fg-muted">Stacked, in a sheet</p>
            <KitCanvas canvas="surface">
              <HistoryDemo layout="stacked" />
            </KitCanvas>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs leading-4.5 font-medium text-fg-muted">Split, on a page</p>
            <KitCanvas>
              <HistoryDemo layout="split" />
            </KitCanvas>
          </div>
        </div>
      </KitBlock>

      <StatesGrid columns={2}>
        <StateCell label="Loading" align="stretch">
          <DiffView loading title={draftPrs.title} className="flex-1" />
        </StateCell>
        <StateCell label="Error" align="stretch">
          <DiffView
            title={draftPrs.title}
            error={{
              message: "Couldn't load the changes.",
              detail: "Check your connection and try again.",
              onRetry: () => undefined,
            }}
            className="flex-1"
          />
        </StateCell>
        <StateCell label="No changes" align="stretch">
          <DiffView
            title="Workspace instructions"
            before={workspaceInstructions.markdown}
            after={workspaceInstructions.markdown}
            className="flex-1"
          />
        </StateCell>
        <StateCell label="New content" note="A new skill: every line is added." align="stretch">
          <DiffView lines={newSkill.diff} title={newSkill.title} className="flex-1" />
        </StateCell>
        <StateCell
          label="Long document"
          note="Unchanged lines collapse, keeping three around each change."
          align="stretch"
          span="full"
        >
          <DiffView before={LONG_BEFORE} after={LONG_AFTER} title="Workspace instructions" />
        </StateCell>
        <StateCell label="Restore not allowed" align="stretch">
          <RevisionHistory
            revisions={INSTRUCTION_REVISIONS}
            now={KIT_NOW}
            onRestore={() => undefined}
            restoreDisabledReason="Only workspace admins can restore instructions."
            className="flex-1"
          />
        </StateCell>
        <StateCell label="Mobile 390" width="mobile" align="stretch">
          <DiffView lines={residency.diff} title={residency.title} />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Reviewing a proposed change to knowledge, instructions or a skill before it's applied",
          "Showing what a saved version changed, with Restore",
        ]}
        avoid={[
          "Code review (use the code diff viewer, with line numbers and syntax)",
          "Showing a single current value (show the text itself)",
        ]}
      >
        Prefer Inline. Use Split for long rewrites on wide screens, and Prose for short knowledge
        entries where the sentence matters more than the lines.
      </UsageNotes>
    </KitSection>
  );
}
