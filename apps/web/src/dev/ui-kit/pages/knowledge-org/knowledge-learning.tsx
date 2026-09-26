import { useState } from "react";
import { CalendarClockIcon, GraduationCapIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailBody,
  DetailFooter,
  DetailHeader,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
} from "@/components/ui/detail-sheet";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";

import { learningModes, organization, type LearningMode } from "../../fixtures";
import {
  KNOWLEDGE_WORKSPACE,
  LEARNING_CONSEQUENCE,
  LEARNING_DESTINATION_LABEL,
  LEARNING_LABEL,
  LEARNING_OVERRIDES,
  type LearningDestination,
  type LearningGroup,
  type LearningState,
} from "./knowledge-data";
import { wait, type PagePicks } from "./picks";

/* ----------------------------------------------------------------------------
   The Learning sheet (Q29, Q30): one control, "Automatic | Review first |
   Off", worded the same everywhere. Shared chats and your private chats are
   two labelled groups; each change saves at once.
   -------------------------------------------------------------------------- */

const DESTINATIONS: LearningDestination[] = ["knowledge", "instructions", "skills"];

function ModeRow({
  picks,
  destination,
  value,
  onChange,
}: {
  picks: PagePicks;
  destination: LearningDestination;
  value: LearningMode;
  onChange: (mode: LearningMode) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <SettingRow
      variant={picks.settingRow}
      controlWidth="auto"
      label={LEARNING_DESTINATION_LABEL[destination]}
      description={LEARNING_CONSEQUENCE[destination][value]}
      control={
        <SegmentedControl<LearningMode>
          size="sm"
          variant={picks.segmented}
          options={learningModes.map((mode) => ({ value: mode.id, label: mode.label }))}
          value={value}
          pending={pending}
          onValueChange={async (mode) => {
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

export interface LearningSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  picks: PagePicks;
  learning: LearningState;
  onChange: (group: LearningGroup, destination: LearningDestination, mode: LearningMode) => void;
  /** Q30: two labelled groups, or today's single switcher. */
  layout: "groups" | "switcher";
}

export function LearningSheet({
  open,
  onOpenChange,
  picks,
  learning,
  onChange,
  layout,
}: LearningSheetProps) {
  const [switcher, setSwitcher] = useState<LearningGroup>("shared");

  const change = async (
    group: LearningGroup,
    destination: LearningDestination,
    mode: LearningMode,
  ) => {
    await wait(450);
    onChange(group, destination, mode);
    toast(
      `${LEARNING_DESTINATION_LABEL[destination]}: ${LEARNING_LABEL[mode]}. Applies to new messages.`,
    );
  };

  const rows = (group: LearningGroup, destinations: LearningDestination[]) => (
    <SettingRowGroup>
      {destinations.map((destination) => (
        <ModeRow
          key={destination}
          picks={picks}
          destination={destination}
          value={learning[group][destination]}
          onChange={(mode) => change(group, destination, mode)}
        />
      ))}
    </SettingRowGroup>
  );

  return (
    <DetailSheet open={open} onOpenChange={onOpenChange}>
      <DetailSheetContent>
        <DetailHeader
          leading={<LogoTile icon={<GraduationCapIcon />} />}
          title="Learning"
          subtitle="What agents can change on their own, and what waits in Review."
        />
        <DetailBody>
          {layout === "groups" ? (
            <>
              <DetailSection
                title={`Shared chats in ${KNOWLEDGE_WORKSPACE.name}`}
                description="Everyone's shared chats and schedules here. Workspace admins can change this."
              >
                {rows("shared", DESTINATIONS)}
              </DetailSection>
              <DetailSection
                title="Your private chats (all workspaces)"
                description={`Only me chats and your Personal workspace, anywhere in ${organization.name}.`}
              >
                {rows("private", ["knowledge", "skills"])}
                <InlineHelp icon className="mt-3">
                  Instructions for private chats only apply in your Personal workspace, so they're
                  set there.
                </InlineHelp>
              </DetailSection>
            </>
          ) : (
            <DetailSection>
              <SegmentedControl<LearningGroup>
                aria-label="Defaults"
                variant={picks.segmented}
                options={[
                  { value: "shared", label: "Workspace defaults" },
                  { value: "private", label: "My defaults" },
                ]}
                value={switcher}
                onValueChange={setSwitcher}
              />
              <div className="mt-3">{rows(switcher, DESTINATIONS)}</div>
            </DetailSection>
          )}
          <DetailSection
            title="Different settings"
            description={`${LEARNING_OVERRIDES.length} schedules use their own settings.`}
          >
            <RowList label="Schedules with their own learning settings">
              {LEARNING_OVERRIDES.map((override) => (
                <ListRow
                  key={override.id}
                  leading={<LogoTile icon={<CalendarClockIcon />} />}
                  title={override.name}
                  description={override.detail}
                  href={`#${override.id}`}
                  onOpen={(event) => event.preventDefault()}
                  indicator="open"
                />
              ))}
            </RowList>
          </DetailSection>
        </DetailBody>
        <DetailFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="pointer-coarse:h-11"
          >
            Done
          </Button>
        </DetailFooter>
      </DetailSheetContent>
    </DetailSheet>
  );
}
