import { REPOSITORY_PANEL_CLASS } from "@/components/repository-picker-layout";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  AudioLinesIcon,
  BoxIcon,
  ChevronLeftIcon,
  GitBranchIcon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  cloneElement,
  isValidElement,
  useState,
  useRef,
  type ReactElement,
  type ReactNode,
  type CSSProperties,
} from "react";

import {
  SessionToolsMenuBody,
  sessionToolSelectionSummary,
  SESSION_TOOLS_PANEL_CLASS,
  type SessionToolSelection,
} from "@/components/pickers";
import { Button } from "@/components/ui/button";
const AgentLearningSettingsEditor = lazy(() =>
  import("@/components/knowledge/agent-learning-settings").then((module) => ({
    default: module.AgentLearningSettingsEditor,
  })),
);
const AgentLearningDraftEditor = lazy(() =>
  import("@/components/knowledge/agent-learning-settings").then((module) => ({
    default: module.AgentLearningDraftEditor,
  })),
);
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { repoCountLabel } from "@/lib/format";
import type { McpServerOption } from "@/lib/session-tools";

type Panel = "root" | "tools" | "repos" | "voice" | "variables";

/**
 * Shared composer actions at every width; model and voice stay in the bar.
 */
export function ComposerMobilePlus(props: {
  /** Centered composers need viewport-sized panels rather than trigger-side space. */
  expandedPanelPresentation?: "menu" | "dialog";
  draftChatSettings?: {
    workspaceId: string;
    scope: "workspace" | "personal";
    value: import("@opengeni/sdk").AgentLearningOverrides;
    onChange: (value: import("@opengeni/sdk").AgentLearningOverrides) => void;
  };
  chatSettings?: {
    workspaceId: string;
    sessionId: string;
    scope: "workspace" | "personal";
    canEdit: boolean;
  };
  disabled?: boolean;
  fileUploadsEnabled: boolean;
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  toolsDisabled?: boolean;
  toolsSaving?: boolean;
  onToolSelectionChange: (selection: SessionToolSelection) => void;
  /** When set, Repositories appears under + and opens a drill-in panel. */
  repositories?: {
    selectedCount: number;
    disabled?: boolean;
    /** Panel element; receives `leading` (back control) via clone. */
    panel: ReactElement<{ leading?: ReactNode }>;
  };
  variableSets?: {
    selectedCount: number;
    panel: ReactElement<{ leading?: ReactNode; onClose?: () => void }>;
  };
  /** When set, Voice model appears under + (bar keeps a start-only control). */
  voiceModel?: {
    selectedLabel: string;
    disabled?: boolean;
    /** Panel element; receives `leading` (back control) via clone. */
    panel: ReactElement<{ leading?: ReactNode }>;
  };
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("root");
  const toolSummary = sessionToolSelectionSummary(props);
  const toolsAvailable = toolSummary.total > 0;
  const repositories = props.repositories;
  const voiceModel = props.voiceModel;
  const dialogOpen = open && panel !== "root" && props.expandedPanelPresentation === "dialog";

  const backButton = (
    <button
      type="button"
      aria-label="Back"
      className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
      onClick={(event) => {
        event.preventDefault();
        setPanel("root");
      }}
    >
      <ChevronLeftIcon className="size-4" />
    </button>
  );

  return (
    <>
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
            setPanel("root");
          }
        }}
      >
        <DropdownMenu
          open={open && !dialogOpen}
          onOpenChange={(next) => {
            if (dialogOpen) return;
            setOpen(next);
            if (!next) setPanel("root");
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={props.disabled}
              aria-label="More composer actions"
              className="size-8 pointer-coarse:size-11 shrink-0 rounded-full text-fg-muted hover:text-fg"
            >
              <PlusIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <ComposerPanelContent
            dialog={dialogOpen}
            panel={panel}
            triggerRef={triggerRef}
            className={
              panel === "tools"
                ? SESSION_TOOLS_PANEL_CLASS
                : panel === "variables"
                  ? "flex w-[min(24rem,calc(100vw-1.5rem))] max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl border-border bg-surface p-2 shadow-xl"
                  : panel === "voice"
                    ? "flex w-[min(20rem,calc(100vw-1.5rem))] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl p-2"
                    : panel === "repos"
                      ? REPOSITORY_PANEL_CLASS
                      : "min-w-52 rounded-xl"
            }
          >
            {panel === "root" ? (
              <>
                {props.fileUploadsEnabled ? (
                  <DropdownMenuItem
                    className="pointer-coarse:min-h-11"
                    disabled={props.disabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      setOpen(false);
                      const root =
                        triggerRef.current?.closest<HTMLElement>("[data-og-composer-id]");
                      root?.querySelector<HTMLInputElement>("[data-og-composer-attach]")?.click();
                    }}
                  >
                    <PaperclipIcon className="size-4" />
                    Add photos & files
                  </DropdownMenuItem>
                ) : null}
                {toolsAvailable ? (
                  <DropdownMenuItem
                    className="pointer-coarse:min-h-11"
                    disabled={props.disabled || props.toolsDisabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      setPanel("tools");
                    }}
                  >
                    <PlugIcon className="size-4" />
                    Tools
                    <span className="ml-auto text-2xs text-fg-subtle">
                      {props.toolsSaving ? "Saving…" : toolSummary.label}
                    </span>
                  </DropdownMenuItem>
                ) : null}
                {repositories ? (
                  <DropdownMenuItem
                    className="pointer-coarse:min-h-11"
                    disabled={props.disabled || repositories.disabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      setPanel("repos");
                    }}
                  >
                    <GitBranchIcon className="size-4" />
                    Repositories
                    <span className="ml-auto text-2xs text-fg-subtle">
                      {repositories.selectedCount > 0
                        ? repoCountLabel(repositories.selectedCount)
                        : "Optional"}
                    </span>
                  </DropdownMenuItem>
                ) : null}
                {props.variableSets ? (
                  <DropdownMenuItem
                    className="pointer-coarse:min-h-11"
                    disabled={props.disabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      setPanel("variables");
                    }}
                  >
                    <BoxIcon className="size-4" />
                    Variable sets
                    {props.variableSets.selectedCount > 0 ? (
                      <span className="ml-auto text-2xs text-fg-subtle">
                        {props.variableSets.selectedCount}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ) : null}
                {voiceModel ? (
                  <DropdownMenuItem
                    className="pointer-coarse:min-h-11"
                    disabled={props.disabled || voiceModel.disabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      setPanel("voice");
                    }}
                  >
                    <AudioLinesIcon className="size-4" />
                    Voice model
                    <span className="ml-auto max-w-[7rem] truncate text-2xs text-fg-subtle">
                      {voiceModel.selectedLabel}
                    </span>
                  </DropdownMenuItem>
                ) : null}
                {props.chatSettings || props.draftChatSettings ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    <SettingsIcon className="size-4" />
                    Chat settings
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : panel === "tools" ? (
              <SessionToolsMenuBody
                presentation={dialogOpen ? "dialog" : "menu"}
                servers={props.servers}
                firstPartyTools={props.firstPartyTools}
                selection={props.selection}
                onChange={props.onToolSelectionChange}
                leading={backButton}
              />
            ) : panel === "repos" && repositories ? (
              withLeading(repositories.panel, backButton)
            ) : panel === "variables" && props.variableSets ? (
              cloneElement(props.variableSets.panel, {
                leading: backButton,
                onClose: () => {
                  setOpen(false);
                  setPanel("root");
                },
              })
            ) : panel === "voice" && voiceModel ? (
              withLeading(voiceModel.panel, backButton)
            ) : null}
          </ComposerPanelContent>
        </DropdownMenu>
      </Dialog>
      {props.chatSettings || props.draftChatSettings ? (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Chat settings</DialogTitle>
              <DialogDescription>
                Agent learning for this chat. Unchanged choices follow your defaults.
              </DialogDescription>
            </DialogHeader>
            <Suspense
              fallback={
                <p role="status" className="text-sm text-fg-muted">
                  Loading settings…
                </p>
              }
            >
              {props.chatSettings ? (
                <AgentLearningSettingsEditor
                  key={props.chatSettings.sessionId}
                  workspaceId={props.chatSettings.workspaceId}
                  scope={props.chatSettings.scope}
                  source={{ kind: "chat", id: props.chatSettings.sessionId }}
                  canEdit={props.chatSettings.canEdit}
                />
              ) : props.draftChatSettings ? (
                <AgentLearningDraftEditor {...props.draftChatSettings} disabled={props.disabled} />
              ) : null}
            </Suspense>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function ComposerPanelContent(props: {
  dialog: boolean;
  panel: Panel;
  triggerRef: { current: HTMLButtonElement | null };
  className: string;
  children: ReactNode;
}) {
  if (props.dialog) {
    return (
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={`${props.className} gap-0 max-sm:mx-auto max-sm:bottom-3 sm:max-w-none ${
          props.panel === "repos"
            ? "sm:w-[min(560px,calc(100vw-2rem))] sm:p-0 sm:pb-0"
            : props.panel === "variables"
              ? "sm:w-[min(24rem,calc(100vw-1.5rem))] sm:p-2 sm:pb-2"
              : "sm:w-[min(20rem,calc(100vw-1.5rem))] sm:p-2 sm:pb-2"
        }`}
        style={
          {
            // Reuse the picker bodies' scroll limits without an anchor-side constraint.
            "--radix-dropdown-menu-content-available-height": "calc(85dvh - 24px)",
            maxHeight: "min(70dvh, calc(100dvh - 24px))",
          } as CSSProperties
        }
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.triggerRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">
          {props.panel === "repos"
            ? "Repositories"
            : props.panel === "tools"
              ? "Tools"
              : props.panel === "variables"
                ? "Variable sets"
                : "Voice model"}
        </DialogTitle>
        {props.children}
      </DialogContent>
    );
  }

  return (
    <DropdownMenuContent
      align="start"
      side="top"
      sideOffset={8}
      collisionPadding={12}
      className={props.className}
    >
      {props.children}
    </DropdownMenuContent>
  );
}

function withLeading(
  panel: ReactElement<{ leading?: ReactNode }>,
  leading: ReactNode,
): ReactElement {
  if (!isValidElement(panel)) {
    throw new Error("ComposerMobilePlus panel must be a valid React element");
  }
  return cloneElement(panel, { leading });
}
