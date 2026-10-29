import { CheckIcon, InfoIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { containedPortal } from "../ui/portal-container";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";
import { useOpenGeniText } from "../messages/runtime";
import { useTimelineAnswerFollow } from "./timeline-answer-follow";

const DialogContainedPortal = containedPortal(Dialog.Portal);

export type SessionCapabilityFrameProps = {
  name: string;
  subtitle: string;
  logo: string | null;
  /** A short kind label for the setup dialog's subtitle; the card itself shows none. */
  typeLabel: string;
  /**
   * A quiet label beside the name, only where it tells a person what they are
   * trusting (a server someone added by hand). Reviewed services show none.
   */
  badge?: string | undefined;
  description: string;
  /**
   * The description is the agent's reason for asking: keep it to two lines so
   * a long rationale never pushes the action down. State and guidance copy
   * stays whole.
   */
  clampDescription?: boolean | undefined;
  skill: boolean;
  expanded: boolean;
  complete: boolean;
  /** Completion copy must reflect the provider's actual scope of access. */
  completeLabel?: string | undefined;
  actionLabel: string;
  /** Direct navigation actions should not announce a dialog on the card. */
  opensDialog?: boolean;
  note: string;
  onOpen(): void;
  onClose(): void;
  busy?: boolean;
  opener?: RefObject<HTMLButtonElement | null>;
  cardRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  /** A catalogue row can own the opener while reusing the same details dialog. */
  dialogOnly?: boolean;
  /**
   * Replaces the action when the viewer cannot start setup here (the provider
   * is not configured, or someone else must connect it). Say why and who can.
   */
  actionUnavailable?: ReactNode;
  /** Host-owned content inside the card, under its status or actions. */
  details?: ReactNode;
  /** Protected setup can stay in the conversation instead of opening a dialog. */
  inlineSetup?: ReactNode;
};

function Mark({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="og-session-capability-logo" aria-hidden>
      {src && failed !== src ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : (
        name.trim().slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

/** The same conversation card in the console and embedded clients. Setup
 * content owns the provider flow; this frame owns identity and protected focus. */
export function SessionCapabilityFrame({
  name,
  subtitle,
  logo,
  typeLabel,
  badge,
  description,
  clampDescription = false,
  skill,
  expanded,
  complete,
  completeLabel,
  actionLabel,
  opensDialog = true,
  note,
  onOpen,
  onClose,
  busy = false,
  opener,
  cardRef,
  children,
  dialogOnly = false,
  actionUnavailable,
  details,
  inlineSetup,
}: SessionCapabilityFrameProps) {
  const t = useOpenGeniText();
  const localOpener = useRef<HTMLButtonElement>(null);
  const localCard = useRef<HTMLElement>(null);
  const buttonRef = opener ?? localOpener;
  const sectionRef = cardRef ?? localCard;
  const rootRef = useRef<HTMLDivElement>(null);
  const portalStyle = usePortalTokenStyle(sectionRef.current);
  // Finishing the card here is the person's answer and the agent continues
  // from it: let the conversation follow that answer. Only a completion the
  // person brought about in this card counts. A card that was already complete
  // when it appeared, or whose saved completion loads after it appears while
  // the person reads elsewhere, asks nothing.
  const followAnswer = useTimelineAnswerFollow();
  const wasComplete = useRef(complete);
  const engaged = useRef(false);
  useLayoutEffect(() => {
    if (expanded || busy) engaged.current = true;
  }, [expanded, busy]);
  const engage = () => {
    engaged.current = true;
  };
  useLayoutEffect(() => {
    if (complete && !wasComplete.current && engaged.current && rootRef.current)
      followAnswer?.(rootRef.current);
    wasComplete.current = complete;
  }, [complete, followAnswer]);
  const identity = (
    <>
      <Mark src={logo} name={name} />
      <div className="og-session-capability-identity">
        <h3>{name}</h3>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {badge ? <span className="og-session-capability-type">{badge}</span> : null}
    </>
  );
  return (
    // React bubbles the setup dialog's portaled events here too.
    <div
      ref={rootRef}
      className="og-session-capability"
      onPointerDownCapture={engage}
      onClickCapture={engage}
      onKeyDownCapture={engage}
    >
      <section
        hidden={dialogOnly}
        style={dialogOnly ? { display: "none" } : undefined}
        ref={sectionRef}
        tabIndex={-1}
        aria-label={t("sessionCapabilityFrame.nameSetup", { name })}
        data-state={complete ? "complete" : expanded ? "setup" : "suggested"}
        className="og-session-capability-shell"
      >
        <div className="og-session-capability-header">
          {identity}
          {complete ? <CheckIcon size={16} aria-hidden /> : null}
        </div>
        {complete ? (
          // Focusable so a card that just finished can keep keyboard focus.
          <p role="status" tabIndex={-1} className="og-session-capability-copy">
            {completeLabel ??
              (skill
                ? t("sessionCapabilityFrame.installedWorkspace")
                : t("sessionCapabilityFrame.connectedAvailableInThisConversation"))}
          </p>
        ) : (
          <>
            <p
              className="og-session-capability-copy"
              data-clamp={clampDescription ? "" : undefined}
              title={clampDescription ? description : undefined}
            >
              {description}
            </p>
            {inlineSetup ? (
              <div className="og-session-capability-setup">{inlineSetup}</div>
            ) : actionUnavailable ? (
              <div className="og-session-capability-actions" data-unavailable="">
                <span role="note">
                  <InfoIcon size={13} aria-hidden />
                  {actionUnavailable}
                </span>
              </div>
            ) : (
              <div className="og-session-capability-actions">
                <span>
                  <ShieldCheckIcon size={13} aria-hidden />
                  {skill
                    ? t("sessionCapabilityFrame.guidanceOnlyNoAccountAccess")
                    : t("sessionCapabilityFrame.youChooseWhatToAuthorize")}
                </span>
                <button
                  ref={buttonRef}
                  type="button"
                  onClick={onOpen}
                  disabled={busy}
                  aria-haspopup={opensDialog ? "dialog" : undefined}
                  aria-expanded={opensDialog ? expanded : undefined}
                >
                  {actionLabel}
                </button>
              </div>
            )}
          </>
        )}
        {details}
      </section>
      {!complete && !dialogOnly && note ? (
        <p className="og-session-capability-note">{note}</p>
      ) : null}
      <Dialog.Root
        open={expanded && !complete}
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContainedPortal>
          <Dialog.Overlay className="og-root og-session-capability-overlay" style={portalStyle} />
          <Dialog.Content
            className="og-root og-session-capability-dialog"
            style={portalStyle}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = buttonRef.current?.isConnected
                ? buttonRef.current
                : sectionRef.current;
              // Keep the view where the conversation is; focus alone must not scroll.
              if (target?.isConnected) target.focus({ preventScroll: true });
            }}
          >
            <div className="og-session-capability-dialog-header">
              <Mark src={logo} name={name} />
              <div>
                <Dialog.Title>{name}</Dialog.Title>
                <Dialog.Description>
                  {[typeLabel, subtitle].filter(Boolean).join(" · ")}
                </Dialog.Description>
              </div>
              {!busy ? (
                <Dialog.Close aria-label={t("sessionCapabilityFrame.closeConnectionSetup")}>
                  <XIcon size={18} />
                </Dialog.Close>
              ) : null}
            </div>
            <div className="og-session-capability-dialog-body">{children}</div>
          </Dialog.Content>
        </DialogContainedPortal>
      </Dialog.Root>
    </div>
  );
}
