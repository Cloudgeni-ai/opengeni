import { CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";

export type SessionCapabilityFrameProps = {
  name: string;
  subtitle: string;
  logo: string | null;
  typeLabel: string;
  description: string;
  skill: boolean;
  expanded: boolean;
  complete: boolean;
  /** Completion copy must reflect the provider's actual scope of access. */
  completeLabel?: string;
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
  description,
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
}: SessionCapabilityFrameProps) {
  const localOpener = useRef<HTMLButtonElement>(null);
  const localCard = useRef<HTMLElement>(null);
  const buttonRef = opener ?? localOpener;
  const sectionRef = cardRef ?? localCard;
  const portalStyle = usePortalTokenStyle(sectionRef.current);
  const identity = (
    <>
      <Mark src={logo} name={name} />
      <div className="og-session-capability-identity">
        <h3>{name}</h3>
        <span>{subtitle}</span>
      </div>
      <span className="og-session-capability-type">{typeLabel}</span>
    </>
  );
  return (
    <div className="og-session-capability">
      <section
        hidden={dialogOnly}
        style={dialogOnly ? { display: "none" } : undefined}
        ref={sectionRef}
        tabIndex={-1}
        aria-label={`${name} setup`}
        data-state={complete ? "complete" : expanded ? "setup" : "suggested"}
        className="og-session-capability-shell"
      >
        <div className="og-session-capability-header">
          {identity}
          {complete ? <CheckIcon size={16} aria-hidden /> : null}
        </div>
        {complete ? (
          <p role="status" className="og-session-capability-copy">
            {completeLabel ??
              (skill ? "Installed · Workspace" : "Connected · Available in this conversation")}
          </p>
        ) : (
          <>
            <p className="og-session-capability-copy">{description}</p>
            <div className="og-session-capability-actions">
              <span>
                <ShieldCheckIcon size={13} aria-hidden />
                {skill ? "Guidance only · no account access" : "You choose what to authorize"}
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
          </>
        )}
      </section>
      {!complete && !dialogOnly ? <p className="og-session-capability-note">{note}</p> : null}
      <Dialog.Root
        open={expanded && !complete}
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <Dialog.Portal>
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
              if (target?.isConnected) target.focus();
            }}
          >
            <div className="og-session-capability-dialog-header">
              <Mark src={logo} name={name} />
              <div>
                <Dialog.Title>{name}</Dialog.Title>
                <Dialog.Description>
                  {typeLabel}
                  {subtitle ? ` · ${subtitle}` : ""}
                </Dialog.Description>
              </div>
              {!busy ? (
                <Dialog.Close aria-label="Close connection setup">
                  <XIcon size={18} />
                </Dialog.Close>
              ) : null}
            </div>
            <div className="og-session-capability-dialog-body">{children}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
