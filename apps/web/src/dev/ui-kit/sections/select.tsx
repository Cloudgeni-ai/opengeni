import { useId, useState, type ReactNode } from "react";

import { Field } from "@/components/ui/field";
import {
  ComboboxPanelPreview,
  SelectMenu,
  SelectMenuPanel,
  type SelectMenuVariant,
  type SelectOption,
} from "@/components/ui/select-menu";
import {
  currentWorkspace,
  defaultModel,
  designPreviewAccess,
  gatewayProviders,
  modelCatalog,
  people,
  repositories,
  timeZones,
  workspaceRoles,
  type WorkspaceRole,
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

/* ----------------------------------------------------------------------------
   Options from the fixtures.
   -------------------------------------------------------------------------- */

const modelOptions: SelectOption[] = modelCatalog.map((model) => ({
  value: model.id,
  label: model.label,
  meta: model.payer,
  description: model.description,
  disabled: !model.available,
  disabledReason: model.unavailableReason,
}));

const groupedModelOptions: SelectOption[] = modelOptions.map((option) => ({
  ...option,
  group: option.meta,
}));

const openRouter = gatewayProviders.find((provider) => provider.id === "openrouter")!;
const longModelOptions: SelectOption[] = [
  ...modelOptions.filter((option) => !option.disabled),
  ...openRouter.customModels.map((model) => ({
    value: `openrouter:${model}`,
    label: model,
    meta: "OpenRouter",
    description: "A custom model from your OpenRouter key, billed to that key.",
  })),
];

const roleOptions: SelectOption<WorkspaceRole>[] = workspaceRoles.map((role) => ({
  value: role.id,
  label: role.label,
  description: role.description,
}));

const timeZoneOptions: SelectOption[] = timeZones.map((zone) => ({
  value: zone.id,
  label: zone.label,
  meta: zone.offsetLabel,
  keywords: [zone.id, zone.shortLabel],
}));

const repositoryOptions: SelectOption[] = repositories.map((repository) => ({
  value: repository,
  label: repository,
}));

function Initials({ initials }: { initials: string }) {
  return (
    <span className="grid size-5 place-items-center rounded-full bg-surface-3 text-2xs font-medium text-fg-muted">
      {initials}
    </span>
  );
}

const hasAccess = new Set(designPreviewAccess.map((entry) => entry.personId));
const peopleOptions: SelectOption[] = people
  .filter((person) => !person.isYou)
  .map((person) => {
    const reason = hasAccess.has(person.id)
      ? `Already has access to ${currentWorkspace.name}.`
      : person.status === "suspended"
        ? `Suspended. An admin can reactivate ${person.name.split(" ")[0]} in People.`
        : undefined;
    return {
      value: person.id,
      label: person.name,
      meta: person.email ?? undefined,
      leading: <Initials initials={person.initials} />,
      description: person.statusLabel,
      disabled: Boolean(reason),
      disabledReason: reason,
    };
  })
  // People you can add come first; the ones you can't follow with the reason.
  .sort((a, b) => Number(a.disabled) - Number(b.disabled));

function PreviewCaption({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-2xs font-medium text-fg-subtle">{children}</p>;
}

/* ----------------------------------------------------------------------------
   Fork: the same two fields in each version.
   -------------------------------------------------------------------------- */

function ForkDemo({ variant }: { variant: SelectMenuVariant }) {
  const [model, setModel] = useState<string>(defaultModel.id);
  const [role, setRole] = useState<WorkspaceRole>("member");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Field label="Default model">
        <SelectMenu
          variant={variant}
          options={modelOptions}
          value={model}
          onValueChange={setModel}
          searchPlaceholder="Search models"
        />
      </Field>
      <Field label="Workspace role">
        <SelectMenu
          variant={variant}
          options={roleOptions}
          value={role}
          onValueChange={setRole}
          searchPlaceholder="Search roles"
        />
      </Field>
      <div className="min-w-0 border-t border-border pt-4">
        {variant === "native" ? (
          <>
            <PreviewCaption>Open</PreviewCaption>
            <p className="text-xs leading-4.5 text-fg-muted">
              The browser draws its own list: one line per option, so the payer is squeezed into the
              label and a description only shows for the chosen option.
            </p>
          </>
        ) : variant === "menu" ? (
          <>
            <PreviewCaption>Open, pointer on GPT-6 Luna</PreviewCaption>
            <SelectMenuPanel preview options={modelOptions} value={model} activeIndex={1} />
          </>
        ) : (
          <>
            <PreviewCaption>Open, searching &ldquo;astra&rdquo;</PreviewCaption>
            <ComboboxPanelPreview
              options={modelOptions}
              value={model}
              query="astra"
              searchPlaceholder="Search models"
              activeValue="codex:gpt-6-astra"
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Section
   -------------------------------------------------------------------------- */

function DefaultModelRow() {
  const labelId = useId();
  const [model, setModel] = useState<string>("openrouter:meta-llama/llama-4-maverick");
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1 basis-56">
        <p id={labelId} className="text-sm font-medium text-fg">
          Default model
        </p>
        <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
          Used for new chats and schedules that don&apos;t pick one.
        </p>
      </div>
      <SelectMenu
        size="sm"
        aria-labelledby={labelId}
        options={longModelOptions}
        value={model}
        onValueChange={setModel}
        className="w-60"
      />
    </div>
  );
}

export default function SelectSection() {
  return (
    <KitSection sectionKey="select">
      <Fork>
        <Alternative id="a" canvas="surface">
          <ForkDemo variant="native" />
        </Alternative>
        <Alternative id="b" canvas="surface">
          <ForkDemo variant="menu" />
        </Alternative>
        <Alternative id="c" canvas="surface">
          <ForkDemo variant="combobox" />
        </Alternative>
      </Fork>

      <StatesGrid description="The recommended version, B. Open menus are drawn in place so every state shows at once; the triggers open the real popover.">
        <StateCell label="Closed, nothing chosen" canvas="surface" align="stretch">
          <Field label="Default model">
            <SelectMenu options={modelOptions} placeholder="Choose a model" />
          </Field>
        </StateCell>
        <StateCell label="Closed, chosen" canvas="surface" align="stretch">
          <Field label="Default model">
            <SelectMenu options={modelOptions} defaultValue={defaultModel.id} />
          </Field>
        </StateCell>
        <StateCell label="Loading" canvas="surface" align="stretch">
          <Field label="Default model">
            <SelectMenu options={[]} loading loadingLabel="Loading models…" />
          </Field>
        </StateCell>

        <StateCell
          label="Disabled with reason"
          canvas="surface"
          align="stretch"
          note="The reason says who can change it."
        >
          <Field label="Default model">
            <SelectMenu
              options={modelOptions}
              defaultValue={defaultModel.id}
              disabled
              disabledReason="Only workspace admins can change the default model."
            />
          </Field>
        </StateCell>
        <StateCell
          label="Error"
          canvas="surface"
          align="stretch"
          note="The Field's error sets the danger border and is read with the select."
        >
          <Field
            label="Default model"
            error="The model you picked was removed. Choose another one."
          >
            <SelectMenu options={modelOptions} placeholder="Choose a model" />
          </Field>
        </StateCell>
        <StateCell label="Empty" canvas="surface" align="stretch" note="No connected accounts yet.">
          <SelectMenuPanel
            preview
            options={[]}
            value={null}
            emptyMessage="No models yet. Connect a Codex account or add OpenGeni credits in Models."
          />
        </StateCell>

        <StateCell
          label="Open"
          canvas="surface"
          align="stretch"
          note="Pointer on Workspace admin; the check marks Member. The menu opens 6px below."
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <Field label="Workspace role">
              <SelectMenu options={roleOptions} defaultValue="member" />
            </Field>
            <SelectMenuPanel preview options={roleOptions} value="member" activeIndex={2} />
          </div>
        </StateCell>
        <StateCell
          label="Disabled option with reason"
          canvas="surface"
          align="stretch"
          note="Grouped by payment source. The unavailable model says why and who can fix it."
        >
          <SelectMenuPanel preview options={groupedModelOptions} value={defaultModel.id} />
        </StateCell>
        <StateCell
          label="Long text, in a row"
          canvas="surface"
          align="stretch"
          note="32px in rows at a fixed 240px: long names truncate in the trigger and wrap in the menu."
        >
          <div className="flex min-w-0 flex-col gap-4">
            <DefaultModelRow />
            <SelectMenuPanel
              preview
              options={longModelOptions.slice(3)}
              value="openrouter:meta-llama/llama-4-maverick"
            />
          </div>
        </StateCell>

        <StateCell
          label="Mobile 390"
          span="full"
          canvas="surface"
          align="stretch"
          width="mobile"
          note="The menu keeps 12px from the screen edges; rows grow to 44px on touch screens."
        >
          <div className="flex min-w-0 flex-col gap-3">
            <Field label="Default model">
              <SelectMenu options={modelOptions} defaultValue={defaultModel.id} />
            </Field>
            <SelectMenuPanel preview options={modelOptions} value={defaultModel.id} />
          </div>
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Combobox for long lists"
        description="Search first, whichever version you pick: people, time zones and repositories. Type to filter; the first Escape clears the search."
      >
        <div className="grid min-w-0 gap-4 @4xl/kit-section:grid-cols-3">
          <KitCanvas canvas="surface" className="flex min-w-0 flex-col gap-3">
            <Field label={`Add people to ${currentWorkspace.name}`}>
              <SelectMenu
                variant="combobox"
                options={peopleOptions}
                placeholder="Choose a person"
                searchPlaceholder="Search people"
              />
            </Field>
            <ComboboxPanelPreview
              options={peopleOptions}
              value={null}
              searchPlaceholder="Search people"
              activeValue="person-jonas"
            />
          </KitCanvas>
          <KitCanvas canvas="surface" className="flex min-w-0 flex-col gap-3">
            <Field label="Time zone">
              <SelectMenu
                variant="combobox"
                options={timeZoneOptions}
                defaultValue="Europe/Oslo"
                searchPlaceholder="Search time zones"
              />
            </Field>
            <ComboboxPanelPreview
              options={timeZoneOptions}
              value="Europe/Oslo"
              query="new"
              searchPlaceholder="Search time zones"
              activeValue="America/New_York"
            />
          </KitCanvas>
          <KitCanvas canvas="surface" className="flex min-w-0 flex-col gap-3">
            <Field label="Repository">
              <SelectMenu
                variant="combobox"
                options={repositoryOptions}
                defaultValue="acme-robotics/platform"
                searchPlaceholder="Search repositories"
              />
            </Field>
            <ComboboxPanelPreview
              options={repositoryOptions}
              value="acme-robotics/platform"
              query="billing"
              searchPlaceholder="Search repositories"
            />
          </KitCanvas>
        </div>
      </KitBlock>

      <UsageNotes
        use={[
          "5 or more options, or a list that comes from the server",
          "A model with its payment source; a workspace role with what it allows",
          "Combobox: long or remote lists that need search - people, repositories, time zones",
          "32px in rows at a fixed 240px, 36px in forms at full width",
        ]}
        avoid={[
          "Actions on an object - use a dropdown menu (Row ⋯)",
          "2-4 short options that should stay visible - use a segmented control",
          "2-3 options that each need a consequence sentence - use choice cards",
          "A combobox for fewer than about 8 options",
        ]}
      />
    </KitSection>
  );
}
