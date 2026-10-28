import { useOptionalAppContext } from "../../app-context";
import { archiveActionLabel } from "../../lib/archive-session";
// The session header bar — the slim canvas top strip's contents on a session
// route. Split out of the session shell as a PURE, presentational component: it takes
// plain session data + callbacks and renders the two-line identity block
// (breadcrumb → title) on the left and the action cluster on the right
// (provider+model·effort·speed, sandbox, pin, connection, status, panel).
// The live children that need their own hooks — the sandbox switcher and the
// subscription account control — arrive as slots so the whole bar can be rendered
// (and screenshotted) in isolation. `CanvasTopStrip` in session-shell owns the
// data wiring and passes the real slots.
import { t } from "../../lib/console-text";
import { cn } from "../../lib/utils";
import { OPEN_WORKSTREAM_CONTROL_EVENT } from "../../../workstream-control-event";
import {
  SessionStatus as SessionStatusBadge,
  SESSION_STATUS_META,
  StatusDot,
} from "../../../components/session-status";
import { sessionDisplayStatus, type SessionDisplayStatus } from "../../../session-status-model";
import { ModelMark } from "../../../components/model-mark";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import type { SessionEventsConnectionState } from "../../../hooks/use-session-events";
import type { SessionSummary } from "@opengeni/sdk";
import { SiteOriginLink, SiteOriginMenuItem } from "../session/site-origin-link";
import { sessionSiteOrigin } from "../../lib/session-site-origin";
import type { CreateBotTemplateRequest, WorkspaceBotTemplate } from "@opengeni/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
  BotIcon,
  CalendarClockIcon,
  GaugeIcon,
  LinkIcon,
  LockIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PauseIcon,
  PencilIcon,
  PinIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SmartphoneIcon,
  UserRoundPenIcon,
  ZapIcon,
  ZapOffIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { BillingClassMark, type BillingClass } from "../billing-class-mark";
import { ConnectionPill } from "../common";
import {
  GrantSessionAdminAccessDialog,
  SessionAdminAccessIndicator,
  SessionAdminAccessMenuItems,
  type SessionAdminAccessControl,
} from "../session/session-admin-access";
import { SessionAncestryBreadcrumb } from "../session/subagents";
import {
  SESSION_HEADER_PARTS,
  useSessionHeaderOverflow,
  type SessionHeaderPart,
} from "./session-header-overflow";
import { Button } from "../../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { useActionShortcut } from "../../lib/actions/actions-provider";
import { useChatOperations } from "../../lib/actions/chat-operations";
import { RENAME_CURRENT_CHAT_EVENT } from "../../lib/actions/events";
import { Skeleton } from "../../../ui/skeleton";
import { requestConversationFind } from "../../lib/conversation-find-event";
import { currentPhoneAppPlatform, openInAppUrl } from "../../lib/open-in-app";
import { sessionControlPaused, sessionInputWait } from "../../lib/session-rail";
import {
  sessionAutomationWaitLines,
  sessionAutomationWaitWords,
} from "../../../components/automations/automation-model";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../../ui/hover-card";
import { useSessionStartup } from "../../../lib/session-startup";
import { isCodexProductModel } from "../../lib/session-model";
import {
  SESSION_TITLE_MAX_LENGTH,
  sessionDisplayTitle,
  useInlineRename,
  type InlineRename,
} from "../../lib/session-rename";
import { pinLiveAnnouncement } from "../../lib/pin-live-announcement";
import { repliesMuteLabel, type SessionRepliesMute } from "../../lib/inbox";
import { labelEffort, type IntelligenceEffort } from "../../lib/session-tools";
import type { LatencyMode, Session } from "../../types";
import { usePage } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { SessionAvatar } from "../session/session-avatar";
import {
  SessionProfileEditorDialog,
  type UpdateSessionProfileFn,
} from "../session/session-profile-editor";
import { BotTemplateDialog } from "../bots/bot-template-dialog";
import { useUiEventTarget } from "../../lib/ui-events";

const SUBSCRIPTION_RAILS: ReadonlySet<BillingClass> = new Set([
  "codex_subscription",
  "claude_subscription",
  "supergrok_subscription",
]);

export function SessionHeader({
  session,
  ancestors,
  onOpenAutomations,
  lineageLoading,
  lineageError,
  connectionState,
  status,
  keyAuthRequired,
  onForgetAccessKey,
  inspectorOpen,
  onToggleInspector,
  onRename,
  onPin,
  onUpdateProfile,
  onSaveBotTemplate,
  onArchive,
  repliesMute,
  adminAccess,
  onOpenUsageLimit,
  sandboxSlot,
  accountSlot,
  accessSlot,
  leading,
  lastStartedModel,
  lastStartedReasoningEffort,
  lastStartedLatencyMode,
  billingClass,
  modelLabel,
  modelLogoUrl,
  policyLoading,
}: {
  session: Session;
  /** Root-to-direct-parent order. */
  ancestors: SessionSummary[];
  /**
   * Present only when an automation posts into this session. Opens the
   * Automations page filtered to this chat, so the reader can see or edit what
   * puts runs here.
   */
  onOpenAutomations?: ((() => void) | null) | undefined;
  lineageLoading?: boolean | undefined;
  lineageError?: Error | null | undefined;
  connectionState: SessionEventsConnectionState;
  status: Session["status"];
  keyAuthRequired: boolean;
  onForgetAccessKey: () => void;
  inspectorOpen: boolean;
  /** Absent: the surface shows no session panel, so no toggle. */
  onToggleInspector?: (() => void) | undefined;
  onRename: (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
  onPin: (session: Session, pinned: boolean) => Promise<Session | null>;
  /** Saves the chat's name, description and avatar. Absent hides Edit profile. */
  onUpdateProfile?: UpdateSessionProfileFn | null | undefined;
  /** Saves a bot template in the workspace. Absent hides Save as bot template. */
  onSaveBotTemplate?:
    | ((request: CreateBotTemplateRequest) => Promise<WorkspaceBotTemplate>)
    | null
    | undefined;
  /** Archives or restores this root session. Absent hides the action. */
  onArchive?: ((session: Session, archived: boolean) => Promise<void>) | undefined;
  /**
   * The signed-in person's mute on this session's replies. Absent hides the
   * action (sub-agents, people without an inbox, servers without it).
   */
  repliesMute?: SessionRepliesMute | null | undefined;
  /**
   * This session's full access, when the viewer can see it on or give it.
   * Absent hides the shield and the menu action.
   */
  adminAccess?: SessionAdminAccessControl | null | undefined;
  /**
   * Opens this chat's usage limit (Agent tab > Usage). Absent hides the menu
   * item, for servers without usage limits.
   */
  onOpenUsageLimit?: ((() => void) | null) | undefined;
  /** The "Run on <machine>" control — a live component in production. */
  sandboxSlot?: ReactNode | undefined;
  /**
   * Replaces the static provider mark when the session runs on a subscription
   * (Codex, Claude, SuperGrok): the same mark, clickable for the account and
   * its usage. Absent for other payment rails.
   */
  accountSlot?: ReactNode | undefined;
  /** Compact session access state/menu, lazy-mounted by the route shell. */
  accessSlot?: ReactNode | undefined;
  /** Leading control (the mobile hamburger); absent on desktop. */
  leading?: ReactNode | undefined;
  /**
   * Model·effort·latency from the newest turn that durably emitted `turn.started`.
   * Historical — does not follow the composer next-turn picker. Falls back to
   * session creation defaults before any turn has admitted.
   */
  lastStartedModel?: string | undefined;
  lastStartedReasoningEffort?: IntelligenceEffort | undefined;
  lastStartedLatencyMode?: LatencyMode | undefined;
  /** Billing rail: subscription account chip, or the mark for makers without a logo. */
  billingClass?: BillingClass | undefined;
  /** Product model label (e.g. GPT-5.6 Luna). */
  modelLabel?: string | undefined;
  modelLogoUrl?: string | undefined;
  /**
   * True while last-started policy and/or model catalog are still resolving.
   * Avoids flashing session defaults (wrong provider) before admitted truth.
   */
  policyLoading?: boolean | undefined;
}) {
  const uiEvents = useUiEventTarget("document");
  const page = usePage();
  const waiting = sessionInputWait({ ...session, status });
  // A session the runtime could not start reads as stuck, not "Waiting on you".
  const displayStatus = sessionDisplayStatus({
    status,
    admissionBlock: session.admissionBlock,
  });
  const startup = useSessionStartup({ ...session, status });
  const startupLabel =
    startup === "starting"
      ? "Starting"
      : startup === "delayed" || startup === "retrying"
        ? "Waiting to start"
        : undefined;
  const modelId = lastStartedModel?.trim() || session.model;
  const resolvedBilling: BillingClass =
    billingClass ?? (isCodexProductModel(modelId) ? "codex_subscription" : "opengeni_credits");
  const resolvedModel = modelLabel?.trim() || modelDisplayName(modelId);
  const displayEffort: IntelligenceEffort = lastStartedReasoningEffort ?? session.reasoningEffort;
  const displayLatency: LatencyMode = lastStartedLatencyMode ?? session.latencyMode;
  // Subscription rails → clickable account chip, the same for every provider.
  // Other rails → static provider icon only (never invent a text
  // "Opengeni"/"BYOK" word). Don't key off `accountSlot != null`.
  const isSubscriptionRail = SUBSCRIPTION_RAILS.has(resolvedBilling);
  const policyBits = [
    resolvedModel,
    labelEffort(displayEffort),
    displayLatency === "fast"
      ? "Fast"
      : displayLatency === "ultrafast"
        ? "Ultrafast"
        : displayLatency === "priority"
          ? "Priority"
          : null,
  ].filter((bit): bit is string => Boolean(bit));
  const rename = useInlineRename(session, onRename);
  const pin = useSessionPinToggle(session, onPin);
  const context = useOptionalAppContext();
  const canArchive = Boolean(onArchive) && session.parentSessionId === null;
  const [grantAdminOpen, setGrantAdminOpen] = useState(false);
  const canEditProfile = Boolean(onUpdateProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  // Menu actions that move focus (rename input, find field) run after the menu
  // has closed, so its focus restoration cannot steal focus back to the trigger.
  const afterMenuClose = useRef<(() => void) | null>(null);
  const chatOps = useChatOperations();
  const findKeys = useActionShortcut("chat.find");
  const copyLinkKeys = useActionShortcut("chat.copyLink");
  const pinKeys = useActionShortcut("chat.pin");
  const archiveKeys = useActionShortcut("chat.archive");
  const panelKeys = useActionShortcut("view.workspacePanel");
  const hasCrumb =
    Boolean(session.parentSessionId) || ancestors.length > 0 || Boolean(lineageError);
  const overflow = useSessionHeaderOverflow({
    present: SESSION_HEADER_PARTS.filter((part) => {
      switch (part) {
        case "panel":
          return Boolean(onToggleInspector);
        case "access":
          return Boolean(accessSlot);
        case "fullAccess":
          return Boolean(adminAccess?.state.active);
        case "automations":
          return Boolean(onOpenAutomations);
        case "machine":
          return Boolean(sandboxSlot);
        case "site":
          return sessionSiteOrigin(session) !== null;
        case "accessKey":
          return keyAuthRequired;
        default:
          return true;
      }
    }),
    contentKey: sessionDisplayTitle(session),
    resetKey: session.id,
    frozen: rename.editing,
  });
  // In the "…" menu instead of the row (see SESSION_HEADER_PARTS).
  const inMenu = (part: SessionHeaderPart) => overflow.collapsed.has(part);
  const part = overflow.partRef;
  // "Rename" from the ⌘K menu or the desktop menu bar edits this title.
  const startRenaming = rename.startEditing;
  useEffect(() => {
    const start = () => startRenaming();
    uiEvents.addEventListener(RENAME_CURRENT_CHAT_EVENT, start);
    return () => uiEvents.removeEventListener(RENAME_CURRENT_CHAT_EVENT, start);
  }, [uiEvents, startRenaming]);
  const providerControl = isSubscriptionRail ? (
    (accountSlot ?? (
      <BillingClassMark
        billingClass={resolvedBilling}
        className="size-3.5 shrink-0 text-fg-muted"
        aria-label=""
      />
    ))
  ) : (
    // The model maker's logo; the payment rail only when the maker has none.
    <ModelMark
      model={{ id: modelId, logoUrl: modelLogoUrl }}
      className="size-3.5 text-fg-muted"
      fallback={<BillingClassMark billingClass={resolvedBilling} className="size-3.5 shrink-0" />}
    />
  );
  return (
    // An elevated band, not just canvas-with-a-hairline: reading as a real top
    // bar was the light-theme fix — a near-white header on a near-white canvas
    // needs its own surface + a crisp divider to look intentional (and it lifts
    // the dark bar a touch above the canvas too).
    <header
      data-window-drag
      data-titlebar
      className="@container/titlebar flex min-h-14 min-w-0 shrink-0 items-center gap-1 border-b border-border bg-canvas/80 pb-1 pl-[max(clamp(0.5rem,2.5vw,1.25rem),env(safe-area-inset-left))] pr-[max(clamp(0.5rem,2.5vw,1.25rem),env(safe-area-inset-right))] pt-[max(0.375rem,env(safe-area-inset-top))] backdrop-blur supports-[backdrop-filter]:bg-canvas/65"
    >
      {leading}
      {/* Every chat's header is one row of the same height. A child chat's
          way back is a small line above its title, never beside it. The title
          keeps a readable width: when the row is too narrow, the least
          important parts move into the "…" menu (SESSION_HEADER_PARTS). */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <SessionAncestryBreadcrumb
          workspaceId={session.workspaceId}
          parentSessionId={session.parentSessionId}
          ancestors={ancestors}
          loading={lineageLoading}
          error={lineageError}
        />
        <div
          ref={overflow.rowRef}
          data-session-title-row=""
          className={cn("flex min-w-0 items-center gap-1", hasCrumb && "h-7")}
        >
          <div
            ref={overflow.titleRef}
            className={cn("flex min-w-0 items-center gap-1.5", rename.editing && "flex-1")}
          >
            {/* A bot's avatar travels with its title. */}
            {session.avatar ? (
              <button
                type="button"
                aria-label="Edit profile"
                title="Edit profile"
                disabled={!canEditProfile}
                onClick={() => setProfileOpen(true)}
                className="-mr-0.5 flex shrink-0 items-center justify-center rounded-[6px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 enabled:hover:opacity-85 pointer-coarse:size-11"
              >
                <SessionAvatar
                  avatar={session.avatar}
                  name={sessionDisplayTitle(session)}
                  workspaceId={session.workspaceId}
                  seed={session.id}
                  size="sm"
                />
              </button>
            ) : null}
            <SessionTitleEditor session={session} rename={rename} />
          </div>
          {/* Below lg (or when the full badge has no room) the lifecycle is a
              dot beside the title. */}
          <CompactSessionStatus
            paused={sessionControlPaused(session)}
            waiting={Boolean(waiting)}
            status={displayStatus}
            label={startupLabel}
            always={inMenu("status")}
          />
          {session.description && !rename.editing ? (
            // Gives way before anything else: it truncates to nothing on a
            // crowded row and is hidden on narrow screens.
            <span
              data-session-description=""
              title={session.description}
              className="ml-1 hidden min-w-0 max-w-[28rem] shrink-[1000000] truncate text-sm text-fg-muted md:block"
            >
              {session.description}
            </span>
          ) : null}
          {accessSlot && !inMenu("access") ? (
            <span ref={part("access")} className="flex shrink-0 items-center">
              {accessSlot}
            </span>
          ) : null}
          {adminAccess?.state.active && !inMenu("fullAccess") ? (
            <span ref={part("fullAccess")} className="flex shrink-0 items-center">
              <SessionAdminAccessIndicator
                control={adminAccess}
                onChangeTimeLimit={() => setGrantAdminOpen(true)}
              />
            </span>
          ) : null}
          {sessionSiteOrigin(session) && !inMenu("site") ? (
            <span ref={part("site")} className="flex shrink-0 items-center">
              <SiteOriginLink session={session} />
            </span>
          ) : null}
          {onOpenAutomations && !inMenu("automations") ? (
            // The first to give way: its words shorten to its icon before
            // anything moves into the menu. The weight is high enough that
            // the title keeps every pixel until then (a sliver would already
            // truncate it).
            <span
              ref={part("automations")}
              className="flex min-w-6 shrink-[100000] items-center pointer-coarse:min-w-11"
            >
              <AutomationWaitChip session={session} onOpen={onOpenAutomations} />
            </span>
          ) : null}
        </div>
      </div>
      <div ref={overflow.clusterRef} className="flex shrink-0 items-center gap-0.5 lg:gap-2">
        {/* Provider + model · effort · speed stay one cluster on the action side. */}
        {inMenu("model") ? null : (
          <div
            ref={part("model")}
            className="hidden max-w-[18rem] items-center gap-1.5 overflow-hidden text-2xs leading-4 text-fg-muted lg:flex xl:max-w-[22rem]"
          >
            {policyLoading ? (
              <span
                className="inline-flex items-center gap-1.5"
                aria-busy="true"
                aria-label="Loading model"
              >
                <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
                <Skeleton className="h-3 w-36" />
              </span>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium text-fg-muted">
                {providerControl}
                <span className="min-w-0 truncate font-normal">
                  {policyBits.map((bit, index) => (
                    <span key={bit}>
                      {index > 0 ? " · " : null}
                      {bit}
                    </span>
                  ))}
                </span>
              </span>
            )}
          </div>
        )}
        {/* Below lg, machine, find and pin live in the "…" menu. */}
        {sandboxSlot && !inMenu("machine") ? (
          <span ref={part("machine")} className="hidden items-center lg:flex">
            {sandboxSlot}
          </span>
        ) : null}
        {inMenu("find") ? null : (
          <Button
            ref={part("find")}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => requestConversationFind(uiEvents)}
            aria-label="Find in conversation"
            data-conversation-find-trigger=""
            title="Find in conversation (Ctrl/Cmd+F)"
            className="hidden pointer-coarse:size-11 lg:inline-flex"
          >
            <SearchIcon className="size-4" />
          </Button>
        )}
        {inMenu("pin") ? null : (
          <Button
            ref={part("pin")}
            type="button"
            variant={session.pinned ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={session.pinned ? "Unpin session" : "Pin session"}
            aria-pressed={Boolean(session.pinned)}
            aria-busy={pin.busy}
            disabled={pin.busy}
            className="hidden pointer-coarse:size-11 lg:inline-flex"
            onClick={pin.toggle}
          >
            <PinIcon className={session.pinned ? "size-4 fill-current" : "size-4"} />
          </Button>
        )}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {pin.announcement}
        </span>
        {inMenu("status") ? null : (
          <div ref={part("status")} className="hidden items-center gap-2 lg:flex">
            <ConnectionPill state={connectionState} />
            {/* Admission vs lifecycle are different axes, but showing both when
                control is Active (Running + Active) is redundant noise. When
                paused, admission is the headline — hide lifecycle so we don't
                imply the session is still "Running"/"Idle" under a pause gate. */}
            {!sessionControlPaused(session) ? (
              waiting ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-control font-medium text-fg-muted"
                  data-session-wait-badge=""
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  Waiting
                </span>
              ) : (
                <SessionStatusBadge status={displayStatus} label={startupLabel} />
              )
            ) : (
              <WorkstreamControlIndicator session={session} />
            )}
          </div>
        )}
        <span className={cn("sr-only", !inMenu("status") && "lg:hidden")}>
          Connection {connectionState}.
        </span>
        {keyAuthRequired && !inMenu("accessKey") ? (
          <Button
            ref={part("accessKey")}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onForgetAccessKey}
            aria-label="Clear access key"
            className="pointer-coarse:size-11"
          >
            <LockIcon className="size-4" />
          </Button>
        ) : null}
        {onToggleInspector && !inMenu("panel") ? (
          <Button
            ref={part("panel")}
            type="button"
            variant={inspectorOpen ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={onToggleInspector}
            aria-label={inspectorOpen ? "Hide workspace" : "Open workspace"}
            aria-keyshortcuts={panelKeys?.ariaKeys}
            title={
              (inspectorOpen ? "Hide workspace" : "Open workspace") +
              (panelKeys ? ` (${panelKeys.label})` : "")
            }
            className="pointer-coarse:size-11"
          >
            {inspectorOpen ? (
              <PanelRightCloseIcon className="size-4" />
            ) : (
              <PanelRightOpenIcon className="size-4" />
            )}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="More session actions"
              title="More"
              className="pointer-coarse:size-11"
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56"
            onCloseAutoFocus={(event) => {
              const action = afterMenuClose.current;
              if (!action) return;
              afterMenuClose.current = null;
              event.preventDefault();
              action();
            }}
          >
            {onToggleInspector && inMenu("panel") ? (
              <DropdownMenuItem
                aria-keyshortcuts={panelKeys?.ariaKeys}
                onSelect={() => {
                  afterMenuClose.current = onToggleInspector;
                }}
              >
                {inspectorOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
                {inspectorOpen ? "Hide workspace" : "Open workspace"}
                {panelKeys ? <DropdownMenuShortcut>{panelKeys.label}</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className={inMenu("find") ? undefined : "lg:hidden"}
              aria-keyshortcuts={findKeys?.ariaKeys}
              onSelect={() => {
                afterMenuClose.current = () => requestConversationFind(uiEvents);
              }}
            >
              <SearchIcon />
              Find
              {findKeys ? <DropdownMenuShortcut>{findKeys.label}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                afterMenuClose.current = rename.startEditing;
              }}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            {canEditProfile ? (
              <DropdownMenuItem
                onSelect={() => {
                  afterMenuClose.current = () => setProfileOpen(true);
                }}
              >
                <UserRoundPenIcon />
                Edit profile…
              </DropdownMenuItem>
            ) : null}
            {onSaveBotTemplate ? (
              <DropdownMenuItem
                onSelect={() => {
                  afterMenuClose.current = () => setSaveTemplateOpen(true);
                }}
              >
                <BotIcon />
                Save as bot template…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              aria-keyshortcuts={copyLinkKeys?.ariaKeys}
              onSelect={() => void chatOps.copyLink(session)}
            >
              <LinkIcon />
              Copy link
              {copyLinkKeys ? (
                <DropdownMenuShortcut>{copyLinkKeys.label}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={inMenu("pin") ? undefined : "lg:hidden"}
              aria-keyshortcuts={pinKeys?.ariaKeys}
              disabled={pin.busy}
              onSelect={() => pin.toggle()}
            >
              <PinIcon className={session.pinned ? "fill-current" : undefined} />
              {session.pinned ? "Unpin" : "Pin"}
              {pinKeys ? <DropdownMenuShortcut>{pinKeys.label}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
            {currentPhoneAppPlatform() ? (
              <DropdownMenuItem
                onSelect={() => {
                  page.assign(openInAppUrl(page.href()));
                }}
              >
                <SmartphoneIcon />
                Open in app
              </DropdownMenuItem>
            ) : null}
            {sandboxSlot ? (
              <div
                className={cn(
                  "flex min-h-9 items-center px-2 empty:hidden",
                  !inMenu("machine") && "lg:hidden",
                )}
              >
                {sandboxSlot}
              </div>
            ) : null}
            {/* Parts with no room in the header row (SESSION_HEADER_PARTS). */}
            {accessSlot && inMenu("access") ? (
              <div className="flex min-h-9 items-center gap-2 px-2 text-sm text-fg-muted">
                Access
                {accessSlot}
              </div>
            ) : null}
            {onOpenAutomations && inMenu("automations") ? (
              <AutomationWaitMenuItem
                session={session}
                onOpen={() => {
                  afterMenuClose.current = onOpenAutomations;
                }}
              />
            ) : null}
            {inMenu("site") ? <SiteOriginMenuItem session={session} /> : null}
            {keyAuthRequired && inMenu("accessKey") ? (
              <DropdownMenuItem onSelect={onForgetAccessKey}>
                <LockIcon />
                Clear access key
              </DropdownMenuItem>
            ) : null}
            {repliesMute ? (
              <DropdownMenuItem disabled={repliesMute.busy} onSelect={() => repliesMute.toggle()}>
                {repliesMute.muted ? <BellIcon /> : <BellOffIcon />}
                {repliesMuteLabel(repliesMute)}
              </DropdownMenuItem>
            ) : null}
            {onOpenUsageLimit ? (
              <DropdownMenuItem
                onSelect={() => {
                  afterMenuClose.current = onOpenUsageLimit;
                }}
              >
                <GaugeIcon />
                Usage limit
              </DropdownMenuItem>
            ) : null}
            {adminAccess?.state.active && inMenu("fullAccess") ? (
              <>
                <DropdownMenuSeparator />
                <SessionAdminAccessMenuItems
                  control={adminAccess}
                  onChangeTimeLimit={() => setGrantAdminOpen(true)}
                  runAfterClose={(action) => {
                    afterMenuClose.current = action;
                  }}
                />
              </>
            ) : adminAccess?.state.active && adminAccess.state.canRevoke ? (
              <DropdownMenuItem disabled={adminAccess.busy} onSelect={() => adminAccess.revoke()}>
                <ShieldOffIcon />
                Turn off full access
              </DropdownMenuItem>
            ) : adminAccess && !adminAccess.state.active && adminAccess.state.canGrant ? (
              <DropdownMenuItem
                disabled={adminAccess.busy}
                onSelect={() => {
                  afterMenuClose.current = () => setGrantAdminOpen(true);
                }}
              >
                <ShieldCheckIcon />
                Give full access…
              </DropdownMenuItem>
            ) : null}
            {canArchive ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  aria-keyshortcuts={archiveKeys?.ariaKeys}
                  onSelect={() => void onArchive?.(session, !session.archived)}
                >
                  {session.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {context
                    ? archiveActionLabel(context, session)
                    : session.archived
                      ? "Restore"
                      : "Archive"}
                  {session.archived ? (
                    <DropdownMenuMeta>Archived</DropdownMenuMeta>
                  ) : archiveKeys ? (
                    <DropdownMenuShortcut>{archiveKeys.label}</DropdownMenuShortcut>
                  ) : null}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {onUpdateProfile && profileOpen ? (
          <SessionProfileEditorDialog
            session={session}
            update={onUpdateProfile}
            open={profileOpen}
            onOpenChange={setProfileOpen}
          />
        ) : null}
        {onSaveBotTemplate && saveTemplateOpen ? (
          <BotTemplateDialog
            open={saveTemplateOpen}
            onOpenChange={setSaveTemplateOpen}
            workspaceId={session.workspaceId}
            seed={session.id}
            mode="save"
            initial={{
              name: sessionDisplayTitle(session),
              description: session.description ?? "",
              avatar: session.avatar ?? null,
              setupInstructions: "",
              // Shared like the chat, so an Only me chat stays private by default.
              visibility: session.tenancy?.visibility === "private" ? "private" : "workspace",
            }}
            onSubmit={async (values) => {
              const created = await onSaveBotTemplate({ ...values, sourceSessionId: session.id });
              toast.success("Bot template saved", {
                description: created.name,
              });
            }}
          />
        ) : null}
        {adminAccess ? (
          <GrantSessionAdminAccessDialog
            control={adminAccess}
            open={grantAdminOpen}
            onOpenChange={setGrantAdminOpen}
          />
        ) : null}
      </div>
    </header>
  );
}

/**
 * The automations that post into this chat: what they wait for in a few
 * words, every wait on hover, and their settings on click. A paused or
 * finished automation still links to its settings, marked inactive. Narrow
 * headers keep only the icon; its name always carries the whole wait.
 */
function AutomationWaitChip({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const now = new Date();
  const wait = sessionAutomationWaitWords(t, session, { now });
  const lines = sessionAutomationWaitLines(t, session, { now });
  const kind = wait?.kind ?? "none";
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          data-automation-wait={kind}
          aria-label={t("automations.wait.openPanel", {
            wait: wait?.label ?? t("automations.wait.none"),
          })}
          className="inline-flex min-w-0 max-w-60 items-center justify-center gap-1 rounded-full px-1.5 text-2xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-ring/55 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <AutomationWaitIcon kind={kind} />
          <span className="hidden min-w-0 truncate sm:block @max-[34rem]/titlebar:hidden!">
            {wait?.short ?? t("sessionChrome.automation")}
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        collisionPadding={8}
        className="w-auto min-w-56 max-w-[min(22rem,calc(100vw-16px))] p-3"
      >
        <div data-automation-wait-details="" className="grid min-w-0 gap-2.5">
          <p className="text-xs font-medium text-fg">{t("automations.wait.details.heading")}</p>
          <ul className="grid min-w-0 gap-1.5">
            {lines.map((line) => (
              <li
                key={line.text}
                className="flex min-w-0 items-start gap-2 text-xs leading-4 text-fg-muted"
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-fg-subtle">
                  <AutomationWaitIcon kind={line.kind} />
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line.text}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-border pt-2 text-2xs text-fg-subtle">
            {t("automations.wait.details.open")}
          </p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function AutomationWaitIcon({ kind }: { kind: "event" | "schedule" | "none" }) {
  return kind === "event" ? (
    <ZapIcon aria-hidden className="size-3 shrink-0" />
  ) : kind === "schedule" ? (
    <CalendarClockIcon aria-hidden className="size-3 shrink-0" />
  ) : (
    <ZapOffIcon aria-hidden className="size-3 shrink-0" />
  );
}

/** The automation chip as a "…" menu item, for a header with no room for it. */
function AutomationWaitMenuItem({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const wait = sessionAutomationWaitWords(t, session, { now: new Date() });
  return (
    <DropdownMenuItem
      onSelect={onOpen}
      aria-label={t("automations.wait.openPanel", {
        wait: wait?.label ?? t("automations.wait.none"),
      })}
    >
      <AutomationWaitIcon kind={wait?.kind ?? "none"} />
      <span className="min-w-0 truncate">{wait?.short ?? t("sessionChrome.automation")}</span>
    </DropdownMenuItem>
  );
}

/**
 * Small-screen status: a dot beside the title, named for assistive tech.
 * `always` keeps it on wide screens too, when the full badge has no room.
 */
function CompactSessionStatus({
  paused,
  waiting,
  status,
  label,
  always = false,
}: {
  paused: boolean;
  waiting: boolean;
  status: SessionDisplayStatus;
  label?: string | undefined;
  always?: boolean | undefined;
}) {
  const className = cn("inline-flex shrink-0 items-center", !always && "lg:hidden");
  if (paused) {
    return (
      <span data-compact-session-status="paused" title="Paused" className={className}>
        <PauseIcon aria-hidden className="size-2.5 shrink-0 fill-current text-status-waiting" />
        <span className="sr-only">Paused</span>
      </span>
    );
  }
  if (waiting) {
    return (
      <span data-compact-session-status="waiting" title="Waiting" className={className}>
        <span aria-hidden className="size-2 rounded-full bg-status-waiting" />
        <span className="sr-only">Waiting</span>
      </span>
    );
  }
  const name = label ?? SESSION_STATUS_META(t)[status].label;
  return (
    <span
      data-compact-session-status={status}
      data-status={status}
      title={name}
      className={className}
    >
      <StatusDot status={status} className="size-2" />
      <span className="sr-only">{name}</span>
    </span>
  );
}

/** Pause-only header chip (Active is not shown — lifecycle status covers “go”). */
function WorkstreamControlIndicator({ session }: { session: Session }) {
  const control = session.effectiveControl;
  if (control.state !== "paused" || session.status === "cancelled") {
    return null;
  }
  const blocker = control.primaryBlocker;
  const label =
    blocker?.kind === "workspace"
      ? "Workspace paused"
      : control.directState === "paused" || blocker?.sessionId === session.id
        ? "Paused here"
        : `Paused by ${blocker?.displayName ?? "parent"}`;
  return (
    <button
      type="button"
      aria-label={`${label}. Open workstream controls`}
      title={`${label} · open workstream controls`}
      onClick={() => {
        document.dispatchEvent(new Event(OPEN_WORKSTREAM_CONTROL_EVENT));
      }}
      className="inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-full border border-status-waiting/35 bg-status-waiting/10 px-2 py-0.5 text-xs font-medium text-fg hover:bg-status-waiting/15"
    >
      <PauseIcon className="size-3 shrink-0 fill-current text-status-waiting" />
      <span className="hidden truncate sm:inline">{label}</span>
      {control.additionalBlockerCount > 0 ? (
        <span className="hidden shrink-0 sm:inline">+{control.additionalBlockerCount}</span>
      ) : null}
    </button>
  );
}

/** Pin toggle shared by the desktop pin button and the phone "…" menu item. */
function useSessionPinToggle(
  session: Session,
  onPin: (session: Session, pinned: boolean) => Promise<Session | null>,
) {
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const announcementSequence = useRef(0);
  const announce = useCallback((message: string) => {
    announcementSequence.current += 1;
    setAnnouncement(pinLiveAnnouncement(message, announcementSequence.current));
  }, []);
  const toggle = useCallback(() => {
    if (busy) return;
    const nextPinned = !session.pinned;
    setBusy(true);
    void onPin(session, nextPinned)
      .then((updated) => {
        announce(
          updated
            ? `Session ${nextPinned ? "pinned" : "unpinned"}.`
            : `Session was not ${nextPinned ? "pinned" : "unpinned"}.`,
        );
      })
      .catch(() => {
        announce(`Session was not ${nextPinned ? "pinned" : "unpinned"}.`);
      })
      .finally(() => setBusy(false));
  }, [announce, busy, onPin, session]);
  return { busy, toggle, announcement };
}

/**
 * The session header title — display by default, click the title (or the
 * hover pencil / "…" > Rename) to rename inline. Prefers the durable session.title
 * (agent- or user-set), falling back to the initial message / "Untitled
 * session" exactly like the rail list. Enter saves, Esc cancels, blur saves; an
 * empty/unchanged value is a no-op cancel. The live title (context.session)
 * flows in through the session.title_set SSE event the react useSession hook
 * applies, so cross-client renames and agent titling reflect here without a
 * reload. The shared `useInlineRename` hook keeps this behaviour identical to
 * the rail row's rename.
 */
function SessionTitleEditor(props: { session: Session; rename: InlineRename }) {
  const display = sessionDisplayTitle(props.session);
  const rename = props.rename;

  if (rename.editing) {
    return (
      // A calm in-place edit: same size and position as the display title, a
      // soft surface tint + hairline instead of a loud focus ring. The global
      // focus-ring rule is what painted the old blue box; opting out here keeps
      // the rename feeling like editing the text, not filling in a form field.
      <input
        ref={rename.inputRef}
        data-session-title-current={display}
        value={rename.draft}
        onChange={(event) => rename.setDraft(event.target.value)}
        onBlur={() => void rename.commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void rename.commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            rename.cancel();
          }
        }}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        aria-label="Session title"
        dir="auto"
        className="-mx-1.5 w-full min-w-0 truncate rounded-md bg-surface-2/70 px-1.5 text-[15px] font-semibold leading-6 tracking-[-0.01em] outline-hidden ring-1 ring-border-strong focus:outline-hidden focus-visible:outline-hidden"
        style={{ outline: "none" }}
      />
    );
  }

  return (
    <div className="group/title flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        onClick={rename.startEditing}
        title={`${display} · click to rename`}
        dir="auto"
        data-session-title-text=""
        className="min-w-0 shrink truncate rounded-sm text-left text-[15px] font-semibold leading-6 tracking-[-0.01em] text-fg hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/40 pointer-coarse:min-h-11 pointer-coarse:px-2"
      >
        {display}
      </button>
      {/* The pencil earns its pixels only when relevant: hidden at rest and
          revealed on hover/focus. Touch screens rename by tapping the title
          (or "…" > Rename), so the title keeps the row's width. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={rename.startEditing}
        aria-label="Rename session"
        className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100 pointer-coarse:hidden"
      >
        <PencilIcon className="size-3" />
      </Button>
    </div>
  );
}
