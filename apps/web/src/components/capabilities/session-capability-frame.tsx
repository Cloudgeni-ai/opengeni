import { CheckIcon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CapabilityLogo } from "./capability-logo";
import "./session-capability-card.css";

/** The conversation's compact card shell. Setup owns its real provider flow;
 * the shell keeps identity, spacing and feedback stable across those states. */
export function SessionCapabilityFrame({
  name,
  subtitle,
  logo,
  typeLabel,
  description,
  skill,
  expanded,
  complete,
  actionLabel,
  note,
  onOpen,
  opener,
  cardRef,
  children,
}: {
  name: string;
  subtitle: string;
  logo: string | null;
  typeLabel: string;
  description: string;
  skill: boolean;
  expanded: boolean;
  complete: boolean;
  actionLabel: string;
  note: string;
  onOpen(): void;
  opener?: RefObject<HTMLButtonElement | null>;
  cardRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}) {
  return (
    <div className="session-capability-card">
      <section
        ref={cardRef}
        tabIndex={-1}
        aria-label={`${name} setup`}
        data-state={complete ? "complete" : expanded ? "setup" : "suggested"}
        className={cn(
          "session-capability-card__shell border border-border bg-surface text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring",
          complete && "bg-surface-2/50",
        )}
      >
        <div className="session-capability-card__header">
          <CapabilityLogo
            src={logo}
            name={name}
            className="session-capability-identity-logo"
            fallback={skill ? name.trim().slice(0, 1).toUpperCase() || "?" : undefined}
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-fg">{name}</h3>
            {subtitle ? (
              <p className="session-capability-card__subtitle mt-1 leading-4 text-fg-subtle">
                {subtitle}
              </p>
            ) : null}
          </div>
          <span className="session-capability-card__type bg-surface-2 text-fg-muted">
            {typeLabel}
          </span>
          {complete ? (
            <span className="session-capability-card__done-mark rounded-full bg-surface-3 text-fg">
              <CheckIcon className="size-3.5" aria-hidden />
            </span>
          ) : null}
        </div>
        {complete ? (
          <div role="status" className="session-capability-card__status text-fg-muted">
            {skill ? "Installed · Workspace" : "Connected · Available in this conversation"}
            {skill ? (
              <p className="mt-2 text-fg-subtle">
                Available to everyone on the team in this workspace.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <p className="session-capability-card__copy text-fg-muted">{description}</p>
            <div
              className="session-capability-card__actions"
              data-expanded={expanded ? "true" : "false"}
            >
              <p className="session-capability-card__reassure text-fg-subtle">
                <ShieldCheckIcon aria-hidden />
                {skill ? "Guidance only · no account access" : "You choose what to authorize"}
              </p>
              {!expanded ? (
                <div className="session-capability-card__open">
                  <Button ref={opener} size="sm" onClick={onOpen} aria-expanded={false}>
                    {actionLabel}
                  </Button>
                </div>
              ) : null}
            </div>
            {expanded ? <div className="session-capability-card__setup">{children}</div> : null}
          </>
        )}
      </section>
      {!complete ? <p className="session-capability-card__note text-fg-subtle">{note}</p> : null}
    </div>
  );
}
