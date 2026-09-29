import { CalendarClockIcon, UserIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import {
  ChoiceCard,
  ChoiceCards,
  ChoiceCardsSkeleton,
  SelectedCheck,
  selectableSurface,
  type ChoiceCardsVariant,
} from "@/components/ui/choice-cards";
import { SelectMenuPanel } from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";
import {
  apiKeyPresets,
  codexOrganizationAccounts,
  currentWorkspace,
  modelCatalog,
  organization,
  organizationRoles,
  scheduleTemplates,
} from "../fixtures";
import {
  Alternative,
  Fork,
  KitBlock,
  KitCanvas,
  KitSection,
  StateCell,
  StatesGrid,
  UsageNotes,
} from "../kit";
import { usePick } from "../picks";
import type { AlternativeId } from "./registry";

const VARIANT_BY_PICK: Record<AlternativeId, ChoiceCardsVariant> = {
  a: "ring",
  b: "radio",
  c: "list",
};

/* ----------------------------------------------------------------------------
   Real choices, from the fixtures and the brief's copy.
   -------------------------------------------------------------------------- */

type Ownership = "workspace" | "personal";

function OwnershipChoice({
  variant,
  value,
  onValueChange,
  error,
  cardClassName,
}: {
  variant?: ChoiceCardsVariant;
  value?: Ownership | "";
  onValueChange?: (value: Ownership) => void;
  error?: string;
  /** Classes on the second card, to show hover and focus in the states grid. */
  cardClassName?: string;
}) {
  return (
    <ChoiceCards
      variant={variant}
      label="Who can use it?"
      value={value}
      onValueChange={(next) => onValueChange?.(next as Ownership)}
      error={error}
    >
      <ChoiceCard
        value="workspace"
        icon={<UsersIcon />}
        title="Everyone in this workspace"
        description="Agents and automations in this workspace can use your account."
      />
      <ChoiceCard
        value="personal"
        icon={<UserIcon />}
        title="Only me"
        description="Only work you start can use it."
        className={cardClassName}
      />
    </ChoiceCards>
  );
}

type EachRun = "new_chat" | "ongoing_chat";

function EachRunChoice({
  variant,
  value,
  onValueChange,
}: {
  variant?: ChoiceCardsVariant;
  value: EachRun;
  onValueChange: (value: EachRun) => void;
}) {
  return (
    <ChoiceCards
      variant={variant}
      label="Each run"
      value={value}
      onValueChange={(next) => onValueChange(next as EachRun)}
    >
      <ChoiceCard
        value="new_chat"
        title="New chat"
        description="Every run starts fresh. Earlier runs stay in their own chats."
      />
      <ChoiceCard
        value="ongoing_chat"
        title="One ongoing chat"
        description="Each run continues the same chat, so the agent remembers earlier runs."
      />
    </ChoiceCards>
  );
}

/** Maria is an admin, so she can't make someone an owner. */
function InviteRoleChoice({
  variant,
  defaultValue = "member",
}: {
  variant?: ChoiceCardsVariant;
  defaultValue?: string;
}) {
  return (
    <ChoiceCards variant={variant} label="Organization role" defaultValue={defaultValue}>
      {organizationRoles.map((role) => (
        <ChoiceCard
          key={role.id}
          value={role.id}
          title={role.label}
          description={role.description}
          disabled={role.id === "owner"}
          disabledReason={
            role.id === "owner" ? "Only an owner can invite another owner." : undefined
          }
        />
      ))}
    </ChoiceCards>
  );
}

function ApiKeyAccessChoice({ variant }: { variant?: ChoiceCardsVariant }) {
  return (
    <ChoiceCards
      variant={variant}
      label="Access"
      description="What this key can do in Design preview. You can't change it later."
      defaultValue="run_sessions"
      layout="grid"
    >
      {apiKeyPresets.map((preset) => (
        <ChoiceCard
          key={preset.id}
          value={preset.id}
          title={preset.label}
          meta={
            preset.permissions.length > 0 ? `${preset.permissions.length} permissions` : undefined
          }
          description={preset.description}
        />
      ))}
    </ChoiceCards>
  );
}

function SubscriptionSourceChoice({ variant }: { variant?: ChoiceCardsVariant }) {
  const account = codexOrganizationAccounts[0]!;
  return (
    <ChoiceCards variant={variant} label="Use subscriptions from" defaultValue="organization">
      <ChoiceCard
        value="organization"
        title="Organization"
        meta={`${account.name} · ${account.plan}`}
        description={`Use the Codex accounts ${organization.name} shares with this workspace.`}
      />
      <ChoiceCard
        value="workspace"
        title="This workspace"
        description={`Use only the accounts connected to ${currentWorkspace.name}.`}
      />
    </ChoiceCards>
  );
}

/* ----------------------------------------------------------------------------
   Fork: the same two questions in each version.
   -------------------------------------------------------------------------- */

function ForkDemo({ variant }: { variant: ChoiceCardsVariant }) {
  const [ownership, setOwnership] = useState<Ownership>("workspace");
  const [eachRun, setEachRun] = useState<EachRun>("new_chat");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <OwnershipChoice variant={variant} value={ownership} onValueChange={setOwnership} />
      <EachRunChoice variant={variant} value={eachRun} onValueChange={setEachRun} />
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The one selected highlight, on things that aren't radio cards.
   -------------------------------------------------------------------------- */

function TemplateCards() {
  const [picked, setPicked] = useState(scheduleTemplates[0]!.id);
  return (
    <div className="grid min-w-0 gap-2" role="group" aria-label="Start from a template">
      {scheduleTemplates.map((template) => {
        const selected = template.id === picked;
        return (
          <button
            key={template.id}
            type="button"
            aria-pressed={selected}
            onClick={() => setPicked(template.id)}
            className={selectableSurface(
              selected,
              "flex min-w-0 items-start gap-3 rounded-[14px] px-4 py-3 text-left",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-2",
                selected ? "text-brand" : "text-fg-muted",
              )}
            >
              <CalendarClockIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{template.name}</span>
              <span className="mt-0.5 block text-xs leading-4.5 text-fg-muted">
                {template.description}
              </span>
              <span className="mt-1 block text-2xs font-medium text-fg-subtle">
                {template.cadenceLabel}
              </span>
            </span>
            <span className="mt-0.5 flex size-4 shrink-0">
              {selected ? <SelectedCheck /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const modelOptions = modelCatalog.map((model) => ({
  value: model.id,
  label: model.label,
  meta: model.payer,
  description: model.description,
  disabled: !model.available,
  disabledReason: model.unavailableReason,
}));

/* ----------------------------------------------------------------------------
   Section
   -------------------------------------------------------------------------- */

export default function ChoiceCardsSection() {
  const pick = usePick("choice-cards");
  const pickedVariant = VARIANT_BY_PICK[pick ?? "a"];

  return (
    <KitSection sectionKey="choice-cards">
      <Fork>
        <Alternative id="a" canvas="surface">
          <ForkDemo variant="ring" />
        </Alternative>
        <Alternative id="b" canvas="surface">
          <ForkDemo variant="radio" />
        </Alternative>
        <Alternative id="c" canvas="surface">
          <ForkDemo variant="list" />
        </Alternative>
      </Fork>

      <KitBlock
        title="Every real choice, in your pick"
        description="Invite role, API key access and where Codex subscriptions come from, drawn in the version you picked (A until you pick one)."
      >
        <div className="grid min-w-0 gap-4 @4xl/kit-section:grid-cols-2">
          <KitCanvas canvas="surface" className="min-w-0 @4xl/kit-section:col-span-2">
            <ApiKeyAccessChoice variant={pickedVariant} />
          </KitCanvas>
          <KitCanvas canvas="surface" className="min-w-0">
            <InviteRoleChoice variant={pickedVariant} />
          </KitCanvas>
          <KitCanvas canvas="surface" className="min-w-0">
            <SubscriptionSourceChoice variant={pickedVariant} />
          </KitCanvas>
        </div>
      </KitBlock>

      <StatesGrid description="The recommended version, A. Hover and focus are drawn on “Only me” so they show without a pointer.">
        <StateCell label="Nothing chosen yet" canvas="surface" align="stretch">
          <OwnershipChoice />
        </StateCell>
        <StateCell label="Hover" canvas="surface" align="stretch" note="Pointer over “Only me”.">
          <OwnershipChoice value="workspace" cardClassName="bg-surface-2" />
        </StateCell>
        <StateCell label="Selected" canvas="surface" align="stretch">
          <OwnershipChoice value="personal" />
        </StateCell>

        <StateCell
          label="Focus"
          canvas="surface"
          align="stretch"
          note="Keyboard focus on “Only me”. Arrow keys move and select."
        >
          <OwnershipChoice
            value="workspace"
            cardClassName="outline-2 outline-offset-2 outline-ring/55"
          />
        </StateCell>
        <StateCell
          label="Error"
          canvas="surface"
          align="stretch"
          note="Nothing chosen when the form was saved."
        >
          <OwnershipChoice value="" error="Choose who can use this connection." />
        </StateCell>
        <StateCell
          label="Loading"
          canvas="surface"
          align="stretch"
          note="The role list comes from the server's role catalog."
        >
          <ChoiceCardsSkeleton label="Organization role" count={3} />
        </StateCell>

        <StateCell
          label="Disabled with reason"
          canvas="surface"
          align="stretch"
          note="Maria is an admin, so Owner is locked and says why."
        >
          <InviteRoleChoice />
        </StateCell>
        <StateCell
          label="Long text"
          canvas="surface"
          align="stretch"
          note="Titles and descriptions wrap; the check stays on the first line."
        >
          <ChoiceCards label="How should OpenGeni work in Slack?" defaultValue="bot">
            <ChoiceCard
              value="bot"
              title="Add OpenGeni to the Acme Robotics Slack for everyone"
              description="Anyone in the workspace can mention OpenGeni in channels and direct messages, and it answers in the thread."
            />
            <ChoiceCard
              value="personal"
              title="Connect only your own Slack account"
              description="Agents can search, read and send messages as you. Only work you start can use it."
            />
          </ChoiceCards>
        </StateCell>
        <StateCell
          label="Picker row"
          canvas="surface"
          align="stretch"
          note="The same highlight marks the chosen row in a menu."
        >
          <SelectMenuPanel preview options={modelOptions.slice(0, 3)} value="codex:gpt-6-sol" />
        </StateCell>

        <StateCell
          label="Template card"
          canvas="surface"
          align="stretch"
          note="And the chosen template on the empty Schedules page."
        >
          <TemplateCards />
        </StateCell>
        <StateCell
          label="Mobile 390"
          span={2}
          canvas="surface"
          align="stretch"
          width="mobile"
          note="Two across only when the group is 560px or wider; on a phone it stacks."
        >
          <ApiKeyAccessChoice />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "2-3 options where each needs a consequence sentence",
          "Who can use a connection: Everyone in this workspace / Only me",
          "The organization role in the invite dialog, API key access, Each run on a schedule",
          "The selected look of anything picked from a set: templates, picker rows",
        ]}
        avoid={[
          "Simple filters or view switches - use a segmented control",
          "On/off settings that save right away - use a switch",
          "5 or more options, or a list that comes from the server - use a select",
          "A choice that has only one allowed answer - say what happens instead",
        ]}
      />
    </KitSection>
  );
}
