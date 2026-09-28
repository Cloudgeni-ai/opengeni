import { DEFAULT_AGENT_LEARNING } from "@opengeni/contracts";
import type {
  AgentLearningCategory,
  AgentLearningMode,
  AgentLearningSettingsRecord,
} from "@opengeni/sdk";
import { GraduationCapIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { InlineHelp } from "@/components/ui/inline-help";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup, SettingRowSkeleton } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";

import { LEARNING_MODE_LABEL } from "./agent-learning-settings";
import { errorText } from "./knowledge-data";

/* ----------------------------------------------------------------------------
   Learning: what agents may change on their own, and what waits in Review.
   One control, "Automatic | Review first | Off", worded the same everywhere.
   Shared chats and your private chats are two labelled groups; each change
   saves at once, so the page has no footer.
   -------------------------------------------------------------------------- */

export const LEARNING_DESTINATIONS: AgentLearningCategory[] = [
  "knowledge",
  "instructions",
  "skills",
];

export const LEARNING_DESTINATION_LABEL: Record<AgentLearningCategory, string> = {
  knowledge: "Knowledge",
  instructions: "Instructions",
  skills: "Skills",
};

const CONSEQUENCE: Record<AgentLearningCategory, Record<AgentLearningMode, string>> = {
  knowledge: {
    automatic: "Agents add facts and decisions to the Library right away.",
    review_first: "Agents propose facts and decisions. They wait in Review for your OK.",
    off: "Agents can't add knowledge. They still read what's in the Library.",
  },
  instructions: {
    automatic: "Agents can add small rules to the instructions.",
    review_first: "Agents propose rule changes. They wait in Review for your OK.",
    off: "Agents can't change the instructions. People still can.",
  },
  skills: {
    automatic: "Agents can save step-by-step procedures as skills.",
    review_first: "Agents propose new skills. They wait in Review for your OK.",
    off: "Agents can't create or change skills. They still use the ones you have.",
  },
};

const MODES: AgentLearningMode[] = ["automatic", "review_first", "off"];

export type LearningScope = "workspace" | "personal";

export interface LearningDefaults {
  record: AgentLearningSettingsRecord | null;
  modes: Record<AgentLearningCategory, AgentLearningMode>;
  loading: boolean;
  error: string | null;
  reload: () => void;
  save: (category: AgentLearningCategory, mode: AgentLearningMode) => Promise<void>;
}

/** The defaults for shared chats (workspace) or your private chats (personal). */
export function useLearningDefaults(workspaceId: string, scope: LearningScope): LearningDefaults {
  const context = useAppContext();
  const [record, setRecord] = useState<AgentLearningSettingsRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const latest = useRef<AgentLearningSettingsRecord | null>(null);
  latest.current = record;
  useEffect(() => {
    let current = true;
    setRecord(null);
    setError(null);
    void context.client
      .getAgentLearningSettings(workspaceId, scope)
      .then((value) => {
        if (current) setRecord(value);
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [context.client, workspaceId, scope, retry]);

  const save = useCallback(
    async (category: AgentLearningCategory, mode: AgentLearningMode) => {
      const base = latest.current;
      if (!base) return;
      const invocation = context.captureWorkspaceInvocation(workspaceId);
      if (!invocation) return;
      const next = await context.client.saveAgentLearningSettings(workspaceId, {
        scope,
        operationId: crypto.randomUUID(),
        expectedVersion: base.version,
        settings: { ...base.settings, [category]: mode },
      });
      if (context.ownsWorkspaceInvocation(workspaceId, invocation)) setRecord(next);
    },
    [context, workspaceId, scope],
  );

  const modes = Object.fromEntries(
    LEARNING_DESTINATIONS.map((category) => [
      category,
      record?.settings[category] ?? DEFAULT_AGENT_LEARNING[category],
    ]),
  ) as Record<AgentLearningCategory, AgentLearningMode>;

  return {
    record,
    modes,
    loading: record === null && error === null,
    error,
    reload: useCallback(() => setRetry((value) => value + 1), []),
    save,
  };
}

/** "Review first", or "Mixed" when the destinations differ. For the header button. */
export function learningSummary(modes: Record<AgentLearningCategory, AgentLearningMode>): string {
  const values = LEARNING_DESTINATIONS.map((category) => modes[category]);
  return values.every((value) => value === values[0]) ? LEARNING_MODE_LABEL[values[0]!] : "Mixed";
}

/** The line over Review: why changes wait there. */
export function reviewLearningLine(
  modes: Record<AgentLearningCategory, AgentLearningMode>,
): string {
  const waiting = LEARNING_DESTINATIONS.filter(
    (category) => modes[category] === "review_first",
  ).map((category) => LEARNING_DESTINATION_LABEL[category]);
  if (waiting.length === 3) return "These wait for you because Learning is set to Review first.";
  if (waiting.length > 0)
    return `These wait for you because ${waiting.join(" and ")} ${waiting.length === 1 ? "is" : "are"} set to Review first.`;
  return "Agents save changes on their own right now, so new ones won't wait here.";
}

function ModeRow({
  category,
  value,
  disabled,
  onChange,
}: {
  category: AgentLearningCategory;
  value: AgentLearningMode;
  disabled: boolean;
  onChange: (mode: AgentLearningMode) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <SettingRow
      controlWidth="auto"
      label={LEARNING_DESTINATION_LABEL[category]}
      description={CONSEQUENCE[category][value]}
      control={
        <SegmentedControl<AgentLearningMode>
          size="sm"
          aria-label={`${LEARNING_DESTINATION_LABEL[category]}: what agents may change`}
          options={MODES.map((mode) => ({ value: mode, label: LEARNING_MODE_LABEL[mode] }))}
          value={value}
          disabled={disabled}
          pending={pending}
          onValueChange={async (mode) => {
            if (mode === value) return;
            setPending(true);
            try {
              await onChange(mode);
            } finally {
              setPending(false);
            }
          }}
        />
      }
    />
  );
}

function GroupRows({
  defaults,
  categories,
  canEdit,
}: {
  defaults: LearningDefaults;
  categories: AgentLearningCategory[];
  canEdit: boolean;
}) {
  if (defaults.loading) {
    return (
      <SettingRowGroup>
        {categories.map((category) => (
          <SettingRowSkeleton key={category} />
        ))}
      </SettingRowGroup>
    );
  }
  if (defaults.error && !defaults.record) {
    return (
      <Notice
        tone="failed"
        title="Couldn't load these settings"
        action={
          <Button type="button" size="sm" variant="outline" onClick={defaults.reload}>
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {defaults.error}
      </Notice>
    );
  }
  return (
    <SettingRowGroup>
      {categories.map((category) => (
        <ModeRow
          key={category}
          category={category}
          value={defaults.modes[category]}
          disabled={!canEdit}
          onChange={async (mode) => {
            try {
              await defaults.save(category, mode);
              toast(
                `${LEARNING_DESTINATION_LABEL[category]}: ${LEARNING_MODE_LABEL[mode]}. Applies to new messages.`,
              );
            } catch (reason) {
              toast.error(`Couldn't change ${LEARNING_DESTINATION_LABEL[category]}`, {
                description: errorText(reason),
              });
              defaults.reload();
            }
          }}
        />
      ))}
    </SettingRowGroup>
  );
}

export function LearningPage({
  workspaceName,
  organizationName,
  personal,
  canManageWorkspace,
  shared,
  mine,
  onClose,
}: {
  workspaceName: string;
  organizationName: string | null;
  personal: boolean;
  canManageWorkspace: boolean;
  /** Defaults for shared chats in this workspace. */
  shared: LearningDefaults;
  /** Defaults for your private chats. */
  mine: LearningDefaults;
  onClose: () => void;
}) {
  return (
    <DetailPage back={{ label: "Knowledge", onClick: onClose }}>
      <DetailPageHeader
        leading={<LogoTile icon={<GraduationCapIcon />} />}
        title="Learning"
        meta="What agents can change on their own, and what waits in Review"
      />
      <DetailPageBody>
        {!personal ? (
          <DetailSection
            title={`Shared chats in ${workspaceName}`}
            description={
              canManageWorkspace
                ? "Everyone's shared chats and schedules here."
                : "Everyone's shared chats and schedules here. Only workspace admins can change this."
            }
          >
            <GroupRows
              defaults={shared}
              categories={LEARNING_DESTINATIONS}
              canEdit={canManageWorkspace}
            />
          </DetailSection>
        ) : null}
        <DetailSection
          title={personal ? "Your chats" : "Your private chats (all workspaces)"}
          description={
            personal
              ? "Chats in your Personal workspace, and your Only me chats in every workspace."
              : `Only me chats and your Personal workspace, anywhere in ${organizationName ?? "your organization"}.`
          }
        >
          <GroupRows
            defaults={mine}
            categories={personal ? LEARNING_DESTINATIONS : ["knowledge", "skills"]}
            canEdit
          />
          {!personal ? (
            <InlineHelp icon className="mt-3">
              Instructions for private chats only apply in your Personal workspace, so they're set
              there.
            </InlineHelp>
          ) : null}
        </DetailSection>
        <DetailSection>
          <InlineHelp icon>
            A chat or schedule can use its own settings. Change them in the chat's settings or on
            the schedule.
          </InlineHelp>
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}
