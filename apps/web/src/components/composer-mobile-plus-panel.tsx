import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  AudioLinesIcon,
  BoxIcon,
  ChevronRightIcon,
  GitBranchIcon,
  PaperclipIcon,
  PlugIcon,
  SettingsIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type CSSProperties,
} from "react";

import { SessionToolsMenuBody, type SessionToolSelection } from "@/components/pickers";
import {
  COMPOSER_MENU_PANEL_CLASS,
  ComposerMenuHeader,
  MenuBackButton,
} from "@/components/ui/composer-menu";
import { MENU_CHEVRON_CLASS, MENU_NOTE_CLASS } from "@/components/ui/menu-styles";
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
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMeta,
} from "@/components/ui/dropdown-menu";
import { isComposerConnector, type McpServerOption } from "@/lib/session-tools";

import type { SessionConnectorsMenuProps } from "@/components/session-connectors-menu-body";

export type Panel = "root" | "tools" | "repos" | "voice" | "variables" | "settings";

/**
 * Shared composer actions at every width; model and voice stay in the bar.
 */
export type ComposerPlusProps = {
  connectorActions?: Pick<
    SessionConnectorsMenuProps,
    "onReconnect" | "loading" | "error" | "busyId" | "accountControls"
  >;
  onOpenConnectors?: () => void;
  /** Centered composers need viewport-sized panels rather than trigger-side space. */
  expandedPanelPresentation?: "menu" | "dialog";
  /** Anchor below a centered new-chat composer and above a docked composer. */
  menuSide?: "top" | "bottom";
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
  connectorCustomizing?: boolean;
  onConnectorCustomizingChange?: (customizing: boolean) => void;
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
};

export function ComposerMobilePlusPanel(
  props: ComposerPlusProps & {
    triggerRef: { current: HTMLButtonElement | null };
    panel: Panel;
    setPanel: (panel: Panel) => void;
    setOpen: (open: boolean) => void;
    dialogOpen: boolean;
  },
) {
  const { triggerRef, panel, setPanel, setOpen, dialogOpen } = props;
  const connectors = props.servers.filter(isComposerConnector);
  const toolsSelected = connectors.filter((server) =>
    props.selection.mcpServerIds.has(server.id),
  ).length;
  const repositories = props.repositories;
  const voiceModel = props.voiceModel;

  const backButton = (
    <MenuBackButton
      onClick={(event) => {
        event.preventDefault();
        setPanel("root");
      }}
    />
  );

  return (
    <ComposerPanelContent
      dialog={dialogOpen}
      panel={panel}
      triggerRef={triggerRef}
      side={props.menuSide ?? (props.expandedPanelPresentation === "dialog" ? "bottom" : "top")}
      className={COMPOSER_MENU_PANEL_CLASS}
    >
      {panel === "root" ? (
        <>
          {props.fileUploadsEnabled ? (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={props.disabled}
              onSelect={(event) => {
                event.preventDefault();
                setOpen(false);
                const root = triggerRef.current?.closest<HTMLElement>("[data-og-composer-id]");
                root?.querySelector<HTMLInputElement>("[data-og-composer-attach]")?.click();
              }}
            >
              <PaperclipIcon className="size-4" />
              Add photos & files
            </DropdownMenuItem>
          ) : null}
          {
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={props.disabled || props.toolsDisabled}
              onSelect={(event) => {
                event.preventDefault();
                setPanel("tools");
                props.onOpenConnectors?.();
              }}
            >
              <PlugIcon className="size-4" />
              Connectors
              <DropdownMenuMeta>
                {props.toolsSaving ? "Saving…" : toolsSelected || ""}
              </DropdownMenuMeta>
              <ChevronRightIcon className={MENU_CHEVRON_CLASS} />
            </DropdownMenuItem>
          }
          {repositories ? (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={props.disabled || repositories.disabled}
              onSelect={(event) => {
                event.preventDefault();
                setPanel("repos");
              }}
            >
              <GitBranchIcon className="size-4" />
              Repositories
              <DropdownMenuMeta>{repositories.selectedCount || ""}</DropdownMenuMeta>
              <ChevronRightIcon className={MENU_CHEVRON_CLASS} />
            </DropdownMenuItem>
          ) : null}
          {props.variableSets ? (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={props.disabled}
              onSelect={(event) => {
                event.preventDefault();
                setPanel("variables");
              }}
            >
              <BoxIcon className="size-4" />
              Variable sets
              <DropdownMenuMeta>{props.variableSets.selectedCount || ""}</DropdownMenuMeta>
              <ChevronRightIcon className={MENU_CHEVRON_CLASS} />
            </DropdownMenuItem>
          ) : null}
          {voiceModel ? (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={props.disabled || voiceModel.disabled}
              onSelect={(event) => {
                event.preventDefault();
                setPanel("voice");
              }}
            >
              <AudioLinesIcon className="size-4" />
              Voice model
              <DropdownMenuMeta className="max-w-[7rem] truncate">
                {voiceModel.selectedLabel}
              </DropdownMenuMeta>
              <ChevronRightIcon className={MENU_CHEVRON_CLASS} />
            </DropdownMenuItem>
          ) : null}
          {props.chatSettings || props.draftChatSettings ? (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={(event) => {
                event.preventDefault();
                setPanel("settings");
              }}
            >
              <SettingsIcon className="size-4" />
              Chat settings
              <ChevronRightIcon className={`ml-auto ${MENU_CHEVRON_CLASS}`} />
            </DropdownMenuItem>
          ) : null}
        </>
      ) : panel === "tools" ? (
        <SessionToolsMenuBody
          {...props.connectorActions}
          presentation={dialogOpen ? "dialog" : "menu"}
          servers={props.servers}
          firstPartyTools={props.firstPartyTools}
          selection={props.selection}
          customizing={props.connectorCustomizing}
          onCustomizingChange={props.onConnectorCustomizingChange}
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
      ) : panel === "settings" ? (
        <>
          <ComposerMenuHeader title="Chat settings" leading={backButton} />
          <div className="min-h-0 overflow-y-auto overscroll-contain px-2.5 pb-1.5">
            <p className="mb-3 text-xs text-fg-muted">
              Choose what agents can add or update in this chat.
            </p>
            <Suspense
              fallback={
                <p role="status" className={MENU_NOTE_CLASS}>
                  Loading settings…
                </p>
              }
            >
              {props.chatSettings ? (
                <AgentLearningSettingsEditor
                  compact
                  key={props.chatSettings.sessionId}
                  workspaceId={props.chatSettings.workspaceId}
                  scope={props.chatSettings.scope}
                  source={{ kind: "chat", id: props.chatSettings.sessionId }}
                  canEdit={props.chatSettings.canEdit}
                />
              ) : props.draftChatSettings ? (
                <AgentLearningDraftEditor
                  compact
                  {...props.draftChatSettings}
                  disabled={props.disabled}
                />
              ) : null}
            </Suspense>
          </div>
        </>
      ) : null}
    </ComposerPanelContent>
  );
}

function ComposerPanelContent(props: {
  dialog: boolean;
  side: "top" | "bottom";
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
        className={`${props.className} gap-0 max-sm:mx-auto max-sm:bottom-3 sm:max-w-none sm:w-[min(24rem,calc(100vw-1.5rem))] sm:p-2 sm:pb-2`}
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
              ? "Connectors"
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
      side={props.side}
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
