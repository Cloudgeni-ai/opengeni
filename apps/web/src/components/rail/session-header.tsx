// The session header bar — the slim canvas top strip's contents on a session
// route. Split out of rail-shell as a PURE, presentational component: it takes
// plain session data + callbacks and renders the two-line identity block
// (breadcrumb → title → model·effort · sandbox · codex) on the left and the
// live-status cluster (connection, status, lock, panel toggle) on the right.
// The live children that need their own hooks — the sandbox switcher and the
// codex account indicator — arrive as slots so the whole bar can be rendered
// (and screenshotted) in isolation. `CanvasTopStrip` in rail-shell owns the
// data wiring and passes the real slots.
import { SessionStatus as SessionStatusBadge } from "@opengeni/react";
import type { SessionEventsConnectionState } from "@opengeni/react";
import type { SessionSummary } from "@opengeni/sdk";
import { LockIcon, PanelRightIcon, PencilIcon, PinIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { ConnectionPill } from "@/components/common";
import { SpawnedByBreadcrumb } from "@/components/session/subagents";
import { Button } from "@/components/ui/button";
import {
  SESSION_TITLE_MAX_LENGTH,
  sessionDisplayTitle,
  useInlineRename,
} from "@/lib/session-rename";
import type { Session } from "@/types";

export function SessionHeader({
  session,
  parent,
  connectionState,
  status,
  keyAuthRequired,
  onForgetAccessKey,
  inspectorOpen,
  onToggleInspector,
  onRename,
  onPin,
  sandboxSlot,
  codexSlot,
  agentsSlot,
  leading,
}: {
  session: Session;
  /** The direct parent (last ancestor), or null when this session has none. */
  parent: SessionSummary | null;
  connectionState: SessionEventsConnectionState;
  status: Session["status"];
  keyAuthRequired: boolean;
  onForgetAccessKey: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onRename: (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
  onPin: (session: Session, pinned: boolean) => Promise<Session | null>;
  /** The "Run on <machine>" control — a live component in production. */
  sandboxSlot?: ReactNode;
  /** The codex-account indicator — absent for host-credit sessions. */
  codexSlot?: ReactNode;
  /** Legacy header home for the "N agents" chip (moved above the composer). */
  agentsSlot?: ReactNode;
  /** Leading control (the mobile hamburger); absent on desktop. */
  leading?: ReactNode;
}) {
  return (
    // An elevated band, not just canvas-with-a-hairline: reading as a real top
    // bar was the light-theme fix — a near-white header on a near-white canvas
    // needs its own surface + a crisp divider to look intentional (and it lifts
    // the dark bar a touch above the canvas too).
    <header
      data-ope26-session-header
      className="flex h-14 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-b border-border bg-surface/80 px-2 backdrop-blur supports-[backdrop-filter]:bg-surface/65 sm:gap-3 sm:px-5"
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 overflow-hidden">
        {/* Child sessions link back to the manager that spawned them. */}
        <div className="hidden min-w-0 sm:block">
          <SpawnedByBreadcrumb workspaceId={session.workspaceId} parent={parent} />
        </div>
        <SessionTitleEditor session={session} onRename={onRename} />
        {/* One quiet metadata voice: no label-colon grammar, no separator
            soup — the model·effort token (the model earns a touch more weight,
            the effort stays quiet), then the sandbox pill (its own shape, no
            interposed dot), then the codex indicator. */}
        <div className="hidden min-w-0 items-center gap-2 overflow-hidden text-2xs leading-4 text-fg-muted sm:flex">
          <span className="min-w-0 shrink truncate font-medium text-fg-muted">
            {session.model}
            <span className="font-normal text-fg-muted">
              {" "}
              · {String(session.metadata.reasoningEffort ?? "low")}
            </span>
          </span>
          {sandboxSlot}
          {codexSlot}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <div className="hidden xl:contents">{agentsSlot}</div>
        <SessionPinButton session={session} onPin={onPin} />
        <div className="hidden items-center gap-2 md:flex">
          <ConnectionPill state={connectionState} />
          <SessionStatusBadge status={status} />
        </div>
        <span className="sr-only md:hidden">
          Connection {connectionState}. Session {status}.
        </span>
        {keyAuthRequired ? (
          <Button
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
        <Button
          type="button"
          variant={inspectorOpen ? "secondary" : "ghost"}
          size="icon-sm"
          onClick={onToggleInspector}
          aria-label={inspectorOpen ? "Hide session panel" : "Show session panel"}
          className="pointer-coarse:size-11"
        >
          <PanelRightIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function SessionPinButton({
  session,
  onPin,
}: {
  session: Session;
  onPin: (session: Session, pinned: boolean) => Promise<Session | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const announcementId = useId();
  return (
    <>
      <Button
        type="button"
        variant={session.pinned ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label={session.pinned ? "Unpin session" : "Pin session"}
        aria-describedby={announcement ? announcementId : undefined}
        aria-pressed={Boolean(session.pinned)}
        aria-busy={busy}
        disabled={busy}
        className="pointer-coarse:size-11"
        onClick={() => {
          const nextPinned = !Boolean(session.pinned);
          setBusy(true);
          void onPin(session, nextPinned)
            .then((updated) => {
              setAnnouncement(
                updated
                  ? `Session ${nextPinned ? "pinned" : "unpinned"}.`
                  : `Session was not ${nextPinned ? "pinned" : "unpinned"}.`,
              );
            })
            .catch(() => {
              setAnnouncement(`Session was not ${nextPinned ? "pinned" : "unpinned"}.`);
            })
            .finally(() => setBusy(false));
        }}
      >
        <PinIcon className={session.pinned ? "size-4 fill-current" : "size-4"} />
      </Button>
      <span id={announcementId} className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}

/**
 * The session header title — display by default, click the title (or the
 * always-visible pencil) to rename inline. Prefers the durable session.title
 * (agent- or user-set), falling back to the initial message / "Untitled
 * session" exactly like the rail list. Enter saves, Esc cancels, blur saves; an
 * empty/unchanged value is a no-op cancel. The live title (context.session)
 * flows in through the session.title_set SSE event the react useSession hook
 * applies, so cross-client renames and agent titling reflect here without a
 * reload. The shared `useInlineRename` hook keeps this behaviour identical to
 * the rail row's rename.
 */
function SessionTitleEditor(props: {
  session: Session;
  onRename: (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
}) {
  const display = sessionDisplayTitle(props.session);
  const rename = useInlineRename(props.session, props.onRename);

  if (rename.editing) {
    return (
      // A calm in-place edit: same size and position as the display title, a
      // soft surface tint + hairline instead of a loud focus ring. The global
      // focus-ring rule is what painted the old blue box; opting out here keeps
      // the rename feeling like editing the text, not filling in a form field.
      <input
        ref={rename.inputRef}
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
        className="-mx-1.5 w-full truncate rounded-md bg-surface-2/70 px-1.5 text-[15px] font-semibold leading-6 tracking-[-0.01em] outline-none ring-1 ring-border-strong focus:outline-none focus-visible:outline-none"
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
        className="min-w-0 shrink truncate rounded-sm text-left text-[15px] font-semibold leading-6 tracking-[-0.01em] text-fg hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {display}
      </button>
      {/* The pencil earns its pixels only when relevant: hidden at rest,
          revealed on hover/focus, always present on coarse pointers where
          hover doesn't exist. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={rename.startEditing}
        aria-label="Rename session"
        className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
      >
        <PencilIcon className="size-3" />
      </Button>
    </div>
  );
}
