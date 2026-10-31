import {
  BoxIcon,
  ChevronDownIcon,
  FolderIcon,
  LaptopIcon,
  LockIcon,
  MessageSquareIcon,
  PlusIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../../ui/button";
import { COMPOSER_MENU_PANEL_CLASS } from "../../../ui/composer-menu";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import type { Channel } from "../../types";
import { ProjectGlyph } from "../rail/project-glyph";
import type { RunsOnChoices } from "./new-session-settings-menu";

/*
 * The strip above a new chat's message: where the chat is filed (its project),
 * where it runs and who can see it. Each chip shows only when there is
 * something to choose, so the composer's footer stays an action row.
 */

/** A new chat's setup choice shown as a chip in the strip above the message. */
export type SessionSetupSetting = {
  /** The setting's name, for the chip's accessible name and tooltip. */
  label: string;
  /** The current value, shown on the chip. */
  summary: string;
  icon: ReactNode;
  disabled: boolean;
  /** The menu body; `close` closes the chip's menu after a final choice. */
  renderMenu: (close: () => void) => ReactNode;
};

// Setup selections sit above the prompt so the footer remains an action row:
// where the new chat is filed, where it runs and who can see it, each shown
// only when there is something to choose. Tools, repositories and the other
// per-chat settings live under “+” at every width.
export function SessionSetupStrip({
  disabled,
  project,
  runsOn,
  visibility,
}: {
  disabled: boolean;
  project: {
    channels: Channel[];
    selectedChannelId: string | null;
    onChange: (channelId: string | null) => void;
    onCreate: () => void;
  } | null;
  runsOn: SessionSetupSetting | null;
  visibility: SessionSetupSetting | null;
}) {
  return (
    <div
      role="group"
      aria-label="New chat setup"
      // On a narrow composer the chips wrap rather than truncating each other
      // to a letter; one chip longer than the row still truncates.
      className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-3 py-2 sm:px-4"
    >
      {project ? (
        <SessionFolderPicker
          channels={project.channels}
          selectedChannelId={project.selectedChannelId}
          disabled={disabled}
          onChange={project.onChange}
          onCreateProject={project.onCreate}
        />
      ) : null}
      {runsOn ? <SessionSetupChip setting={runsOn} /> : null}
      {visibility ? <SessionSetupChip setting={visibility} /> : null}
    </div>
  );
}

const SESSION_SETUP_CHIP_CLASS =
  "h-8 min-w-0 max-w-[12rem] shrink gap-1.5 overflow-hidden rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg data-[state=open]:border-border data-[state=open]:bg-surface-2 data-[state=open]:text-fg";

/** The Runs on chip's icon: a connected machine, a managed sandbox, or no computer. */
export function runsOnSetupIcon(choices: RunsOnChoices): ReactNode {
  const { compute } = choices.draft;
  if (compute.kind === "machine") {
    const machine = choices.machines.find((item) => item.sandboxId === compute.sandboxId);
    return machine?.os === "macos" ? (
      <LaptopIcon className="size-3.5" />
    ) : (
      <ServerIcon className="size-3.5" />
    );
  }
  return choices.noManagedSandbox ? (
    <MessageSquareIcon className="size-3.5" />
  ) : (
    <BoxIcon className="size-3.5" />
  );
}

/** The Visibility chip's icon. */
export function visibilitySetupIcon(value: "private" | "workspace"): ReactNode {
  return value === "private" ? (
    <LockIcon className="size-3.5" />
  ) : (
    <UsersIcon className="size-3.5" />
  );
}

function SessionSetupChip({ setting }: { setting: SessionSetupSetting }) {
  const [open, setOpen] = useState(false);
  const name = `${setting.label}: ${setting.summary}`;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={setting.disabled}
          aria-label={name}
          title={setting.label}
          className={SESSION_SETUP_CHIP_CLASS}
        >
          {setting.icon}
          <span className="min-w-0 truncate">{setting.summary}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className={COMPOSER_MENU_PANEL_CLASS}
      >
        {setting.renderMenu(() => setOpen(false))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionFolderPicker({
  channels,
  selectedChannelId,
  disabled,
  onChange,
  onCreateProject,
}: {
  channels: Channel[];
  selectedChannelId: string | null;
  disabled: boolean;
  onChange: (channelId: string | null) => void;
  onCreateProject: () => void;
}) {
  const selected = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const label = selected?.name ?? "Default";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Project: ${label}${selected?.visibility === "private" ? ", Only me" : ""}`}
          title={label}
          className={SESSION_SETUP_CHIP_CLASS}
        >
          <ProjectGlyph project={selected} />
          <span className="min-w-0 truncate">{label}</span>
          {selected?.visibility === "private" ? (
            <LockIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-60">
        <DropdownMenuLabel>Save new session in</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <FolderIcon />
          <span className="min-w-0 flex-1 truncate">Default</span>
          <DropdownMenuCheck checked={selectedChannelId === null} />
        </DropdownMenuItem>
        {channels.map((channel) => (
          <DropdownMenuItem key={channel.id} onSelect={() => onChange(channel.id)}>
            <ProjectGlyph project={channel} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{channel.name}</span>
            {channel.visibility === "private" ? (
              <LockIcon aria-label="Only me" className="size-3.5 shrink-0 text-fg-subtle" />
            ) : null}
            <DropdownMenuCheck checked={channel.id === selectedChannelId} />
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={onCreateProject}>
          <PlusIcon />
          New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
