/**
 * "What should the agent do?", shaped like the chat composer: what the runs
 * work with on top (repositories, variable set, environment, tools), the
 * instructions, then "+" for tools and the model with who pays for it. The
 * textarea takes the enclosing Field's label, hint and error.
 */
import { useId, type ReactNode } from "react";
import { useVariableSets } from "@opengeni/react";
import {
  ContainerIcon,
  GitBranchIcon,
  PlugIcon,
  PlusIcon,
  RotateCcwIcon,
  VariableIcon,
  XIcon,
} from "lucide-react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { payerShortLabel } from "@/components/models/models-ui";
import { ModelPicker, type PickerModelRow } from "@/components/pickers";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFieldControlProps } from "@/components/ui/field";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { gitHubRepositoryResource, isRepositoryResourceForGitHubRepo } from "@/lib/session-tools";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";
import { cn } from "@/lib/utils";
import type { ResourceRef } from "@/types";
import type { DefaultModelSelection } from "@opengeni/sdk";

import type { ScheduleDraft } from "./schedule-model";

/** 28px pills (32px on touch screens), with a 44px touch target drawn by a pseudo-element. */
const TOUCH_TARGET =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:content-['']";
const CHIP = cn(
  "h-7 w-auto max-w-full shrink-0 gap-1 rounded-full pr-2 pl-2.5 text-xs pointer-coarse:h-8 [&>svg]:size-3.5",
  TOUCH_TARGET,
);
const CHIP_EMPTY = "border-dashed text-fg-muted hover:text-fg";
const NONE = "__none__";

type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

function repositoryName(resource: RepositoryResource): string {
  const clean = resource.uri.replace(/\.git$/, "").replace(/\/+$/, "");
  return /[:/]([^/:]+\/[^/]+)$/.exec(clean)?.[1] ?? clean;
}

function RemovableChip({
  icon,
  label,
  hint,
  onRemove,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface pr-0.5 pl-2 text-xs text-fg pointer-coarse:h-8">
      <span aria-hidden="true" className="flex shrink-0 text-fg-subtle [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {hint ? <span className="shrink-0 text-fg-subtle">{hint}</span> : null}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        disabled={disabled}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg disabled:pointer-events-none",
          TOUCH_TARGET,
          "pointer-coarse:after:-inset-2.5",
        )}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

function ChipSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
  searchPlaceholder,
  disabled,
  disabledReason,
  loading,
}: {
  label: string;
  placeholder: string;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  searchPlaceholder?: string;
  disabled?: boolean;
  disabledReason?: ReactNode;
  loading?: boolean;
}) {
  const empty = value === null;
  // Its own id and no inherited description or error: the enclosing Field
  // belongs to the instructions, not to these chips.
  const id = useId();
  return (
    <SelectMenu
      id={id}
      aria-label={label}
      aria-describedby=""
      invalid={false}
      variant={options.length > 8 ? "combobox" : "menu"}
      options={options}
      value={value}
      onValueChange={onChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      disabled={disabled}
      disabledReason={disabledReason}
      loading={loading}
      className={cn(CHIP, empty && CHIP_EMPTY)}
      menuClassName="w-80"
    />
  );
}

export interface ComposerFieldProps {
  workspaceId: string;
  draft: ScheduleDraft;
  update: (patch: Partial<ScheduleDraft>) => void;
  disabled?: boolean;
  modelRows: PickerModelRow[];
  defaultModelSelection: DefaultModelSelection | null;
  modelsLoading: boolean;
  modelsError: string | null;
  canAttachOpenGeniTool: boolean;
  /** The existing tools and attachments stay with the chat a run posts into. */
  existingChat: boolean;
}

export function ComposerField({
  workspaceId,
  draft,
  update,
  disabled,
  modelRows,
  defaultModelSelection,
  modelsLoading,
  modelsError,
  canAttachOpenGeniTool,
  existingChat,
}: ComposerFieldProps) {
  const context = useAppContext();
  const fieldProps = useFieldControlProps();
  const invalid = Boolean(fieldProps["aria-invalid"]);

  const can = (permission: Parameters<typeof hasWorkspacePermission>[2]) =>
    hasWorkspacePermission(context.accessContext, workspaceId, permission);
  const canAttachSets = can("variable-sets:attach") && can("variable-sets:use");
  const canListSets = canAttachSets && can("variable-sets:list");
  const variableSets = useVariableSets({ enabled: canListSets && !existingChat });
  const canUseRigs = can("rigs:use");
  const rigs = useWorkspaceRigs({ enabled: canUseRigs && !existingChat });

  /* ----- repositories */
  const repositories = draft.resources.filter(
    (resource): resource is RepositoryResource => resource.kind === "repository",
  );
  const otherResources = draft.resources.filter((resource) => resource.kind !== "repository");
  const unpicked = context.githubRepos.filter(
    (repo) => !repositories.some((resource) => isRepositoryResourceForGitHubRepo(resource, repo)),
  );
  const repositoryOptions: SelectOption[] = unpicked.map((repo) => ({
    value: String(repo.id),
    label: repo.fullName,
    meta: repo.private ? "Private" : undefined,
    leading: <GitBranchIcon className="size-3.5 text-fg-subtle" />,
  }));
  const addRepository = (id: string) => {
    const repo = context.githubRepos.find((candidate) => String(candidate.id) === id);
    if (!repo) return;
    update({
      resources: [
        ...repositories,
        gitHubRepositoryResource(repo, repo.defaultBranch),
        ...otherResources,
      ],
    });
  };
  const removeRepository = (resource: RepositoryResource) =>
    update({ resources: draft.resources.filter((candidate) => candidate !== resource) });

  /* ----- variable set */
  const activeSets = variableSets.variableSets.filter((set) => set.status === "active");
  const selectedSetKnown = activeSets.some((set) => set.id === draft.variableSetId);
  const setOptions: SelectOption[] = [
    ...activeSets.map((set) => ({
      value: set.id,
      label: set.name,
      meta: `${set.variables.length} ${set.variables.length === 1 ? "variable" : "variables"}`,
      description: set.description ?? undefined,
      leading: <VariableIcon className="size-3.5 text-fg-subtle" />,
    })),
    ...(draft.variableSetId && !selectedSetKnown
      ? [
          {
            value: draft.variableSetId,
            label: variableSets.loading ? "Loading…" : "Attached variable set",
            leading: <VariableIcon className="size-3.5 text-fg-subtle" />,
          },
        ]
      : []),
    ...(draft.variableSetId ? [{ value: NONE, label: "No variable set", group: " " }] : []),
  ];

  /* ----- environment */
  const liveRigs = rigs.rigs.filter((rig) => rig.status === "active");
  const selectedRigKnown = liveRigs.some((rig) => rig.id === draft.rigId);
  const rigOptions: SelectOption[] = [
    ...liveRigs.map((rig) => ({
      value: rig.id,
      label: rig.name,
      description: rig.description ?? undefined,
      leading: <ContainerIcon className="size-3.5 text-fg-subtle" />,
      disabled: !rig.activeVersion,
      disabledReason: rig.activeVersion ? undefined : "It has no active version to run yet.",
    })),
    ...(draft.rigId && !selectedRigKnown
      ? [
          {
            value: draft.rigId,
            label: rigs.loading ? "Loading…" : "Attached Sandbox Environment",
            leading: <ContainerIcon className="size-3.5 text-fg-subtle" />,
          },
        ]
      : []),
    ...(draft.rigId ? [{ value: NONE, label: "No environment", group: " " }] : []),
  ];

  /* ----- tools */
  // With agent settings, built-in tools follow "What the agent can do"; the
  // menu then only picks connected apps.
  const agentSettings = context.clientConfig.agentConfig?.enabled === true;
  const servers = context.toolMcpServers.filter((server) => server.id !== "opengeni");
  const selectedTools = draft.mcpServerIds ?? [];
  const toggleTool = (id: string, on: boolean) =>
    update({
      mcpServerIds: on
        ? [...selectedTools.filter((tool) => tool !== id), id]
        : selectedTools.filter((tool) => tool !== id),
    });
  const toolName = (id: string) => servers.find((server) => server.id === id)?.name;
  const toolLogo = (id: string) => servers.find((server) => server.id === id)?.logoSrc ?? null;

  /* ----- model */
  const followed = draft.modelFollowsDefault ? defaultModelSelection : null;
  const selectedRow = modelRows.find((row) => row.id === (followed?.model ?? draft.model));
  const payer = selectedRow ? payerShortLabel(selectedRow) : null;
  const modelMeta = draft.modelFollowsDefault ? (payer ? `Default · ${payer}` : null) : payer;

  const showSetChip = canAttachSets && (setOptions.length > 0 || variableSets.loading);
  const showRigChip = canUseRigs && (rigOptions.length > 0 || rigs.loading);
  const showContext =
    !existingChat &&
    (repositories.length > 0 ||
      repositoryOptions.length > 0 ||
      showSetChip ||
      showRigChip ||
      (draft.includeOpenGeniTool && !agentSettings) ||
      selectedTools.length > 0);
  return (
    <div
      className={cn(
        "min-w-0 rounded-[14px] border bg-surface transition-[border-color,box-shadow] duration-[120ms]",
        invalid
          ? "border-danger has-[textarea:focus]:ring-3 has-[textarea:focus]:ring-danger/15"
          : "border-border hover:border-border-strong has-[textarea:focus]:border-brand has-[textarea:focus]:ring-3 has-[textarea:focus]:ring-brand/15",
      )}
    >
      {showContext ? (
        <div
          role="group"
          aria-label="What the runs work with"
          className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2.5 pointer-coarse:gap-y-2"
        >
          {repositories.map((resource) => (
            <RemovableChip
              key={`${resource.uri}@${resource.ref}`}
              icon={<GitBranchIcon />}
              label={repositoryName(resource)}
              onRemove={() => removeRepository(resource)}
              disabled={disabled}
            />
          ))}
          {repositoryOptions.length > 0 ? (
            <ChipSelect
              label={repositories.length ? "Add a repository" : "Repository"}
              placeholder={repositories.length ? "Add repository" : "Repository"}
              options={repositoryOptions}
              value={null}
              onChange={addRepository}
              searchPlaceholder="Search repositories"
              disabled={disabled}
            />
          ) : null}
          {showSetChip ? (
            <ChipSelect
              label="Variable set"
              placeholder="Variable set"
              options={setOptions}
              value={draft.variableSetId}
              onChange={(value) => update({ variableSetId: value === NONE ? null : value })}
              searchPlaceholder="Search variable sets"
              disabled={disabled}
              loading={variableSets.loading && activeSets.length === 0}
            />
          ) : null}
          {showRigChip ? (
            <ChipSelect
              label="Environment"
              placeholder="Environment"
              options={rigOptions}
              value={draft.rigId}
              onChange={(value) => update({ rigId: value === NONE ? null : value })}
              searchPlaceholder="Search environments"
              disabled={disabled}
              loading={rigs.loading && liveRigs.length === 0}
            />
          ) : null}
          {draft.includeOpenGeniTool && !agentSettings ? (
            <RemovableChip
              icon={<PlugIcon />}
              label="Workspace tools"
              onRemove={() => update({ includeOpenGeniTool: false })}
              disabled={disabled}
            />
          ) : null}
          {selectedTools.map((id) => {
            const name = toolName(id);
            return (
              <RemovableChip
                key={id}
                icon={
                  name ? (
                    <CapabilityLogo src={toolLogo(id)} name={name} size="sm" className="size-4" />
                  ) : (
                    <PlugIcon />
                  )
                }
                label={name ?? id}
                hint={name ? undefined : "Unavailable"}
                onRemove={() => toggleTool(id, false)}
                disabled={disabled}
              />
            );
          })}
        </div>
      ) : null}
      <textarea
        {...fieldProps}
        value={draft.prompt}
        onChange={(event) => update({ prompt: event.target.value })}
        rows={4}
        disabled={disabled}
        placeholder="e.g. Summarize yesterday's AWS spend and flag anything unusual"
        // The frame shows focus (border and glow); the global outline would draw a second ring.
        style={{ outline: "none" }}
        className={cn(
          "field-sizing-content block max-h-72 min-h-24 w-full min-w-0 resize-none bg-transparent px-4 pt-3 pb-2 text-sm leading-5 text-fg placeholder:text-fg-subtle pointer-coarse:text-base",
          !showContext && "rounded-t-[14px]",
        )}
      />
      <div className="flex min-w-0 items-center gap-2 px-3 pb-3">
        {!existingChat ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Add tools"
                disabled={disabled}
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface text-fg-muted transition-colors duration-[120ms] hover:border-border-strong hover:text-fg data-[state=open]:border-border-strong data-[state=open]:text-fg pointer-coarse:size-8",
                  TOUCH_TARGET,
                  "pointer-coarse:after:-inset-x-1.5",
                )}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 rounded-[16px] p-1.5">
              <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-subtle">
                {agentSettings
                  ? "Connected apps this schedule can use"
                  : "Tools this schedule can use"}
              </DropdownMenuLabel>
              {agentSettings && servers.length === 0 ? (
                <p className="px-2 pb-2 text-xs leading-4.5 text-fg-muted">
                  No apps are connected to this workspace yet.
                </p>
              ) : null}
              {agentSettings ? null : (
                <DropdownMenuCheckboxItem
                  checked={draft.includeOpenGeniTool}
                  disabled={!canAttachOpenGeniTool}
                  onCheckedChange={(checked) => update({ includeOpenGeniTool: checked === true })}
                  onSelect={(event) => event.preventDefault()}
                  className="min-h-9 rounded-[8px] pointer-coarse:min-h-11"
                >
                  <PlugIcon className="size-4 text-fg-subtle" />
                  <span className="min-w-0">
                    <span className="block truncate">Workspace tools</span>
                    <span className="block text-xs leading-4.5 text-fg-muted">
                      {canAttachOpenGeniTool
                        ? "Chats, schedules and other work in this workspace."
                        : "Not available on this OpenGeni server."}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              )}
              {servers.map((server) => (
                <DropdownMenuCheckboxItem
                  key={server.id}
                  checked={selectedTools.includes(server.id)}
                  onCheckedChange={(checked) => toggleTool(server.id, checked === true)}
                  onSelect={(event) => event.preventDefault()}
                  className="min-h-9 rounded-[8px] pointer-coarse:min-h-11"
                >
                  <CapabilityLogo
                    src={server.logoSrc ?? null}
                    name={server.name}
                    size="sm"
                    className="size-5 rounded-[6px]"
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{server.name}</span>
                    {server.detail ? (
                      <span className="block truncate text-xs leading-4.5 text-fg-muted">
                        {server.detail}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="text-xs leading-4.5 text-fg-muted">
            Uses the chat's own tools and attachments.
          </span>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {!draft.modelFollowsDefault ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Use the workspace default model"
                  disabled={disabled}
                  onClick={() =>
                    update({
                      modelFollowsDefault: true,
                      ...(defaultModelSelection
                        ? {
                            model: defaultModelSelection.model,
                            reasoningEffort: defaultModelSelection.reasoningEffort,
                          }
                        : {}),
                    })
                  }
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg",
                    TOUCH_TARGET,
                  )}
                >
                  <RotateCcwIcon aria-hidden="true" className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Use the workspace default</TooltipContent>
            </Tooltip>
          ) : null}
          <ModelPicker
            rows={modelRows}
            // Following a default the client can't resolve to a runnable model:
            // name the policy instead of printing a raw model id.
            model={draft.modelFollowsDefault && !selectedRow ? "Workspace default" : draft.model}
            effort={draft.reasoningEffort}
            latencyMode="standard"
            allowLatencyMode={false}
            disabled={disabled}
            loading={modelsLoading}
            error={modelsError}
            messages={{ label: "Model and reasoning" }}
            triggerStyle="field"
            triggerMeta={modelMeta}
            className={cn(
              "inline-flex h-7 max-w-full min-w-0 shrink items-center gap-1.5 rounded-full border border-border bg-surface pr-2 pl-2.5 text-xs text-fg transition-colors duration-[120ms] hover:border-border-strong pointer-coarse:h-8",
              TOUCH_TARGET,
            )}
            onModelChange={(model) => update({ model, modelFollowsDefault: false })}
            onEffortChange={(reasoningEffort) =>
              update({ reasoningEffort, modelFollowsDefault: false })
            }
            onLatencyModeChange={() => {}}
          />
        </div>
      </div>
    </div>
  );
}
