import { useState, type ReactNode } from "react";
import { ChevronDownIcon, PencilIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack, type SectionVariant } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowLink, SettingRowSkeleton } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";

import {
  agentActivity,
  currentWorkspace,
  learningModes,
  learningSettings,
  organization,
  schedules,
  sessionDefaults,
  variableSets,
} from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   Workspace settings > General, built from the real rows and controls.
   -------------------------------------------------------------------------- */

const FAST_SEARCH_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

type FastSearch = (typeof FAST_SEARCH_OPTIONS)[number]["value"];

function PauseMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Pause…
          <ChevronDownIcon aria-hidden="true" className="-mr-0.5 size-3.5 text-fg-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {agentActivity.pauseOptions.map((option) => (
          <DropdownMenuItem key={option}>
            {option === "Now" ? "Pause now" : option}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceSection() {
  return (
    <Section
      title="Workspace"
      description="The name people see, and what this workspace belongs to."
    >
      <SettingRow
        label="Name"
        description={currentWorkspace.name}
        control={
          <Button variant="outline" size="sm">
            <PencilIcon aria-hidden="true" />
            Rename
          </Button>
        }
      />
      <SettingRow label="Type" description={currentWorkspace.typeLabel} />
      <SettingRow
        label="Workspace ID"
        description="Use it with the API and the CLI."
        controlWidth="auto"
        control={
          <CopyField
            value={currentWorkspace.id}
            label="workspace ID"
            size="md"
            truncate="middle"
            maxLength={18}
          />
        }
      />
    </Section>
  );
}

function AgentActivitySection() {
  return (
    <Section
      title="Agent activity"
      description="Pausing stops new agent work in this workspace. Work in progress finishes first."
    >
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            Agents
            <StatusBadge status="running" variant="dot">
              {agentActivity.runningLabel}
            </StatusBadge>
          </span>
        }
        description="Chats and schedules can start new work."
        control={<PauseMenu />}
      />
    </Section>
  );
}

function SessionDefaultsSection({ action }: { action?: ReactNode }) {
  const [voice, setVoice] = useState(sessionDefaults.voiceInput);
  const [fastSearch, setFastSearch] = useState<FastSearch>(sessionDefaults.fastCodeSearch);
  const [apps, setApps] = useState(sessionDefaults.useConnectedAppsAutomatically);
  return (
    <Section
      title="New session defaults"
      description="Applied when someone starts a new session in this workspace."
      action={action}
    >
      <SettingRow
        label="Voice input"
        description="Record a short message and add its transcript to the draft."
        control={<Switch checked={voice} onCheckedChange={setVoice} />}
      />
      <SettingRow
        label="Video generation"
        description="Let agents create short videos."
        hint={<SettingRowLink href="#connect-ai-gateway">Connect AI Gateway</SettingRowLink>}
        control={
          <Switch
            checked={sessionDefaults.videoGeneration}
            disabled
            disabledReason={sessionDefaults.videoGenerationHint}
          />
        }
      />
      <SettingRow
        label="Fast code search"
        description="Index repositories so agents find code faster."
        controlWidth="auto"
        control={
          <SegmentedControl
            options={FAST_SEARCH_OPTIONS}
            value={fastSearch}
            onValueChange={setFastSearch}
            size="sm"
          />
        }
      />
      <SettingRow
        label="Use connected apps automatically"
        description="Agents can use Gmail, Linear and PostHog without asking each time."
        control={<Switch checked={apps} onCheckedChange={setApps} />}
      />
    </Section>
  );
}

/** Quiet but explicit: outlined like the other controls, so its edge lines up. */
function DeleteWorkspaceButton() {
  return (
    <Button variant="outline" size="sm" className="text-danger hover:text-danger">
      Delete workspace…
    </Button>
  );
}

function DeleteWorkspaceSection() {
  return (
    <Section
      title="Delete workspace"
      description={`Deletes ${currentWorkspace.name} for everyone in ${organization.name}. You'll see what depends on it first.`}
      action={<DeleteWorkspaceButton />}
    />
  );
}

function GeneralSettings({ variant }: { variant: SectionVariant }) {
  return (
    <div className="mx-auto w-full max-w-[720px] min-w-0">
      <SectionStack variant={variant}>
        <WorkspaceSection />
        <AgentActivitySection />
        <SessionDefaultsSection />
        <DeleteWorkspaceSection />
      </SectionStack>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   States for the recommended open section.
   -------------------------------------------------------------------------- */

function ScheduleRows() {
  return (
    <>
      {schedules.slice(0, 2).map((schedule) => (
        <SettingRow
          key={schedule.id}
          label={schedule.name}
          description={`${schedule.cadenceLabel} · Next run ${schedule.nextRunLabel}`}
          control={
            <Switch
              defaultChecked={schedule.state === "active"}
              aria-label={`${schedule.name} is active`}
            />
          }
        />
      ))}
    </>
  );
}

const awsProduction = variableSets[0]!;

export default function SectionSection() {
  return (
    <KitSection sectionKey="section">
      <Fork layout="stack">
        <Alternative id="a">
          <GeneralSettings variant="open" />
        </Alternative>
        <Alternative id="b">
          <GeneralSettings variant="group" />
        </Alternative>
        <Alternative id="c">
          <GeneralSettings variant="tiles" />
        </Alternative>
      </Fork>

      <StatesGrid columns={2} description="Version A, the open section.">
        <StateCell label="Title only" align="stretch">
          <Section title="Schedules you own">
            <ScheduleRows />
          </Section>
        </StateCell>

        <StateCell label="With description" align="stretch">
          <Section
            title="Schedules you own"
            description="Paused schedules keep their settings and resume on their next run."
          >
            <ScheduleRows />
          </Section>
        </StateCell>

        <StateCell
          label="With action"
          note="The action centres on the title line, not on the whole header."
          align="stretch"
        >
          <Section
            title="Used by"
            description={`What turns on ${awsProduction.name} today.`}
            action={
              <Button variant="outline" size="sm">
                Add to a schedule
              </Button>
            }
          >
            {awsProduction.usedBy.map((usage) => (
              <SettingRow key={usage.name} label={usage.name} description={usage.kindLabel} />
            ))}
          </Section>
        </StateCell>

        <StateCell
          label="Divided"
          note="Hairlines between sections: 24px above and below."
          align="stretch"
        >
          <SectionStack>
            <Section title="Agent activity" description="Chats and schedules can start new work." />
            <Section
              title="Delete workspace"
              description={`Deletes ${currentWorkspace.name} for everyone.`}
              action={<DeleteWorkspaceButton />}
            />
          </SectionStack>
        </StateCell>

        <StateCell label="Loading" note="Skeleton rows at their final height." align="stretch">
          <Section
            title="New session defaults"
            description="Applied when someone starts a new session in this workspace."
          >
            <SettingRowSkeleton />
            <SettingRowSkeleton controlWidth="auto" />
            <SettingRowSkeleton />
          </Section>
        </StateCell>

        <StateCell
          label="Disabled with reason"
          note="Members see the section; the action explains who can change it."
          align="stretch"
        >
          <Section
            title="New session defaults"
            description="Applied when someone starts a new session in this workspace."
            action={
              <DisabledReason reason="Only workspace admins can change defaults. Ask Maria Chen.">
                <Button variant="outline" size="sm">
                  Reset to defaults
                </Button>
              </DisabledReason>
            }
          >
            <SettingRow
              label="Voice input"
              description="Record a short message and add its transcript to the draft."
              control={
                <Switch
                  checked
                  disabled
                  disabledReason="Only workspace admins can change defaults."
                />
              }
            />
          </Section>
        </StateCell>

        <StateCell
          label="Error"
          note="What happened, what to do, inside the section."
          align="stretch"
        >
          <Section
            title="Agent activity"
            description="Pausing stops new agent work in this workspace. Work in progress finishes first."
          >
            <Notice
              tone="failed"
              action={
                <Button variant="outline" size="sm">
                  <RotateCcwIcon aria-hidden="true" />
                  Try again
                </Button>
              }
            >
              Couldn't load agent activity.
            </Notice>
          </Section>
        </StateCell>

        <StateCell
          label="Long text"
          note="Title and description wrap; the action keeps its size."
          align="stretch"
        >
          <Section
            title="Shared chats in Platform engineering and every workspace created after today"
            description="Knowledge, instructions and skills learned in shared chats. Two schedules use different settings, and your private chats keep their own."
            action={
              <Button variant="outline" size="sm">
                Edit
              </Button>
            }
          >
            <SettingRow
              label="Knowledge"
              description="Facts agents learn while they work, like the staging database being read-only."
              controlWidth="auto"
              control={
                <SegmentedControl
                  size="sm"
                  defaultValue={learningSettings.shared.knowledge}
                  options={learningModes.map((mode) => ({ value: mode.id, label: mode.label }))}
                />
              }
            />
          </Section>
        </StateCell>

        <StateCell label="Mobile 390" width="mobile" align="stretch" span="full">
          <SectionStack>
            <AgentActivitySection />
            <SessionDefaultsSection />
          </SectionStack>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Grouping related rows on a page, a sheet or a dialog.",
          "One quiet action for the whole group, like Add or Edit.",
          "Open sections on pages; the hairline between sections is the only divider.",
        ]}
        avoid={[
          "Around a single control. Use one SettingRow.",
          "Inside another boxed surface. Never a card in a card.",
          "As a page title. Use the page header.",
          "For hiding options. Use a Disclosure for secondary options of the same object.",
        ]}
      />
    </KitSection>
  );
}
