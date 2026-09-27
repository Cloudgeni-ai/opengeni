import type { Revision } from "@/components/ui/revision-history";

import {
  knowledgeEntries,
  learningSettings,
  reviewItems,
  workspaceInstructions,
  workspaces,
  type DiffLine,
  type KnowledgeEntry,
  type KnowledgeScope,
  type KnowledgeType,
  type LearningMode,
  type ReviewItem,
} from "../../fixtures";

/* ----------------------------------------------------------------------------
   Knowledge page state, built from the shared fixtures (brief section 8). A
   few entries are added so every filter has something to show: one private
   entry, one organization entry, one archived and one rejected proposal.
   -------------------------------------------------------------------------- */

/** Knowledge lives in Platform engineering (brief section 8). */
export const KNOWLEDGE_WORKSPACE = workspaces.find(
  (workspace) => workspace.name === "Platform engineering",
)!;

export type EntryStatus = "published" | "archived" | "rejected";
export type EntryType = KnowledgeType | "general";

export interface LibraryEntry extends Omit<KnowledgeEntry, "type"> {
  type: EntryType;
  status: EntryStatus;
  /** Newest first. */
  revisions: Revision[];
}

export const TYPE_LABEL: Record<EntryType, string> = {
  decision: "Decision",
  requirement: "Requirement",
  incident: "Incident",
  fact: "Fact",
  note: "Note",
  general: "General",
};

/** The types people pick from, most common first. */
export const ENTRY_TYPES: Exclude<EntryType, "general">[] = [
  "fact",
  "decision",
  "requirement",
  "incident",
  "note",
];

function firstRevision(entry: KnowledgeEntry, summary = "Created the entry"): Revision {
  return {
    id: `${entry.id}-r1`,
    author: entry.author,
    createdAt: entry.updatedAt,
    summary,
    content: entry.content,
  };
}

const residency = knowledgeEntries.find((entry) => entry.id === "kn-eu-residency")!;
const residencyBefore =
  "Customer data for EU accounts is stored and processed only in eu-north-1. Backups replicate to eu-west-1.";

const extraEntries: LibraryEntry[] = [
  {
    id: "kn-on-call",
    title: "I'm on call 5-11 Oct",
    type: "fact",
    typeLabel: "Fact",
    scope: "personal",
    content:
      "Bendik is the platform on-call engineer from Mon 5 Oct to Sun 11 Oct. Send urgent infrastructure questions to him that week.",
    updatedAt: "2026-09-24T07:10:00Z",
    updatedLabel: "2 days ago",
    author: "Bendik Hansen",
    status: "published",
    revisions: [],
  },
  {
    id: "kn-fiscal-year",
    title: "Fiscal year starts 1 February",
    type: "fact",
    typeLabel: "Fact",
    scope: "organization",
    content:
      "Acme Robotics' fiscal year runs from 1 February to 31 January. Quarterly reports use fiscal quarters, so Q3 is August to October.",
    updatedAt: "2026-08-12T10:00:00Z",
    updatedLabel: "12 Aug",
    author: "Maria Chen",
    status: "published",
    revisions: [],
  },
  {
    id: "kn-friday-freeze",
    title: "No production deploys on Friday afternoons",
    type: "decision",
    typeLabel: "Decision",
    scope: "workspace",
    content:
      "No production deploys after 14:00 on Fridays. Replaced by the second-reviewer rule in September.",
    updatedAt: "2026-09-04T13:20:00Z",
    updatedLabel: "3 weeks ago",
    author: "Jonas Berg",
    status: "archived",
    revisions: [],
  },
  {
    id: "kn-staging-writes",
    title: "Agents can write to staging",
    type: "fact",
    typeLabel: "Fact",
    scope: "workspace",
    source: { kind: "chat", name: "Seed staging fixtures" },
    content: "Agents can write to the staging database to create test fixtures.",
    updatedAt: "2026-09-10T09:05:00Z",
    updatedLabel: "2 weeks ago",
    author: "OpenGeni",
    status: "rejected",
    revisions: [],
  },
];

/**
 * Kit-only touches to the shared entries: the runbook keeps its steps on
 * separate lines, and the outage write-up came from a chat, so the Source
 * filter has a published entry for Files and for Chats.
 */
const ENTRY_OVERRIDES: Record<string, Partial<KnowledgeEntry>> = {
  "kn-datadog-runbook": {
    content:
      "1. Create new API and app keys in Datadog (EU site).\n2. Replace DD_API_KEY and DD_APP_KEY in the Datadog variable set.\n3. Revoke the old keys after the next scheduled run succeeds.",
  },
  "kn-checkout-outage": { source: { kind: "chat", name: "Checkout outage retro" } },
};

export function initialEntries(): LibraryEntry[] {
  const base: LibraryEntry[] = knowledgeEntries.map((fixture) => {
    const entry = { ...fixture, ...ENTRY_OVERRIDES[fixture.id] };
    return {
      ...entry,
      status: "published" as const,
      revisions:
        entry.id === residency.id
          ? [
              {
                id: `${entry.id}-r2`,
                author: "Bendik Hansen",
                createdAt: entry.updatedAt,
                summary: "Added the rule for analytics exports",
                content: entry.content,
              },
              {
                id: `${entry.id}-r1`,
                author: "Maria Chen",
                createdAt: "2026-08-12T08:30:00Z",
                summary: "Created the entry",
                content: residencyBefore,
              },
            ]
          : [firstRevision(entry)],
    };
  });
  const extra = extraEntries.map((entry) => ({
    ...entry,
    revisions: [
      firstRevision(
        { ...entry, type: entry.type === "general" ? "note" : entry.type },
        entry.status === "rejected" ? "Proposed by an agent" : "Created the entry",
      ),
    ],
  }));
  return [...base, ...extra];
}

export const SCOPE_LABEL: Record<KnowledgeScope, string> = {
  workspace: "Workspace",
  personal: "Only me",
  organization: "Organization",
};

/* ----------------------------------------------------------------------------
   Review queue.
   -------------------------------------------------------------------------- */

export interface ReviewEntry extends ReviewItem {
  /** The text after the change, for "Edit first". */
  proposed: string;
  /** The Library entry an update applies to. */
  entryId?: string;
}

/** The proposed text: every line except the removed ones. */
export function proposedText(diff: readonly DiffLine[]): string {
  return diff
    .filter((line) => line.kind !== "removed")
    .map((line) => line.text)
    .join("\n");
}

export function initialReview(): ReviewEntry[] {
  return reviewItems.map((item) => ({
    ...item,
    proposed:
      item.kind === "knowledge"
        ? proposedText(item.diff).replace(/\n/g, " ")
        : proposedText(item.diff),
    entryId: item.id === "review-eu-residency" ? residency.id : undefined,
  }));
}

/* ----------------------------------------------------------------------------
   Workspace instructions and learning.
   -------------------------------------------------------------------------- */

export function initialInstructionRevisions(): Revision[] {
  const [latest, first] = workspaceInstructions.revisions;
  return [
    {
      id: latest!.id,
      author: latest!.author,
      createdAt: "2026-09-23T09:14:00Z",
      summary: latest!.summary,
      content: latest!.markdown,
    },
    {
      id: first!.id,
      author: first!.author,
      createdAt: "2026-09-18T07:40:00Z",
      summary: first!.summary,
      content: first!.markdown,
    },
  ];
}

export type LearningDestination = "knowledge" | "instructions" | "skills";
export type LearningGroup = "shared" | "private";

export type LearningState = Record<LearningGroup, Record<LearningDestination, LearningMode>>;

export function initialLearning(): LearningState {
  return {
    shared: {
      // Review first here (the fixture says Automatic): Review holds a knowledge
      // change from a shared chat, and the page must not contradict itself.
      knowledge: "review_first",
      instructions: learningSettings.shared.instructions,
      skills: learningSettings.shared.skills,
    },
    private: {
      knowledge: learningSettings.private.knowledge,
      instructions: learningSettings.private.instructions,
      skills: learningSettings.private.skills,
    },
  };
}

export const LEARNING_LABEL: Record<LearningMode, string> = {
  automatic: "Automatic",
  review_first: "Review first",
  off: "Off",
};

/** What each mode means for each destination, as one consequence sentence. */
export const LEARNING_CONSEQUENCE: Record<LearningDestination, Record<LearningMode, string>> = {
  knowledge: {
    automatic: "Agents add facts and decisions to the Library right away.",
    review_first: "Agents propose facts and decisions. They wait in Review for your OK.",
    off: "Agents can't add knowledge. They still read what's in the Library.",
  },
  instructions: {
    automatic: "Agents can add small rules to the workspace instructions.",
    review_first: "Agents propose rule changes. They wait in Review for your OK.",
    off: "Agents can't change the instructions. People still can.",
  },
  skills: {
    automatic: "Agents can save step-by-step procedures as skills.",
    review_first: "Agents propose new skills. They wait in Review for your OK.",
    off: "Agents can't create or change skills.",
  },
};

export const LEARNING_DESTINATION_LABEL: Record<LearningDestination, string> = {
  knowledge: "Knowledge",
  instructions: "Instructions",
  skills: "Skills",
};

/** The mode most destinations use, for the header button: "Learning: Review first". */
export function learningSummary(modes: Record<LearningDestination, LearningMode>): string {
  const values = Object.values(modes);
  const counts = new Map<LearningMode, number>();
  for (const mode of values) counts.set(mode, (counts.get(mode) ?? 0) + 1);
  let best: LearningMode | null = null;
  let bestCount = 0;
  for (const [mode, count] of counts) {
    if (count > bestCount) {
      best = mode;
      bestCount = count;
    }
  }
  if (!best || bestCount === 1) return "Mixed";
  return LEARNING_LABEL[best];
}

/** Schedules with their own learning settings (the overrides line). */
// Neither contradicts Review: the dependency PR schedule still proposes
// instruction changes for review, it just doesn't save knowledge.
export const LEARNING_OVERRIDES = [
  {
    id: "schedule-dependency-pr",
    name: "Weekly dependency update PR",
    detail: "Knowledge: Off",
  },
  { id: "schedule-access-review", name: "Monthly access review", detail: "Skills: Off" },
];
