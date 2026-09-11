import { CheckIcon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CapabilityLogo } from "./capability-logo";

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
    <div className="w-full max-w-[540px]">
      <section
        ref={cardRef}
        tabIndex={-1}
        aria-label={`${name} setup`}
        data-state={complete ? "complete" : expanded ? "setup" : "suggested"}
        className={cn(
          "overflow-hidden rounded-[12px] border border-border bg-surface text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring",
          complete && "bg-surface-2/50",
        )}
      >
        <div className="flex items-center gap-3 px-[19px] pt-[18px] pb-3 max-[480px]:gap-[9px] max-[480px]:px-3.5 max-[480px]:pt-4">
          <CapabilityLogo
            src={logo}
            name={name}
            className="size-[41px] rounded-[10px]"
            fallback={skill ? name.trim().slice(0, 1).toUpperCase() || "?" : undefined}
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-fg [overflow-wrap:anywhere]">{name}</h3>
            {subtitle ? (
              <p className="mt-1 text-[11px] leading-4 text-fg-subtle [overflow-wrap:anywhere]">
                {subtitle}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 rounded-[5px] bg-surface-2 px-[7px] py-1 text-[10px] leading-none text-fg-muted">
            {typeLabel}
          </span>
          {complete ? (
            <span className="flex size-[23px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg">
              <CheckIcon className="size-3.5" aria-hidden />
            </span>
          ) : null}
        </div>
        {complete ? (
          <div
            role="status"
            className="px-[19px] pb-4 text-xs leading-[1.7] text-fg-muted max-[480px]:px-3.5"
          >
            {skill ? "Installed · Workspace" : "Connected · Available in this conversation"}
            {skill ? (
              <p className="mt-2 text-[11px] text-fg-subtle">
                Available to everyone on the team in this workspace.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <p className="px-[19px] pb-2 text-xs leading-[1.7] text-fg-muted max-[600px]:pb-0 max-[480px]:px-3.5">
              {description}
            </p>
            <div
              className={cn(
                "items-center gap-x-3 px-[19px] max-[480px]:px-3.5",
                expanded
                  ? "block pb-3"
                  : "grid grid-cols-[minmax(0,1fr)_auto] pb-3.5 max-[600px]:block",
              )}
            >
              <p className="flex items-center gap-2 text-[11px] leading-[1.6] text-fg-subtle max-[600px]:mt-[9px]">
                <ShieldCheckIcon className="size-[13px] shrink-0" aria-hidden />
                {skill ? "Guidance only · no account access" : "You choose what to authorize"}
              </p>
              {!expanded ? (
                <div className="flex justify-end max-[600px]:pt-1.5">
                  <Button
                    ref={opener}
                    size="sm"
                    className="h-[35px] rounded-[7px] px-[13px] text-xs pointer-coarse:min-h-11"
                    onClick={onOpen}
                    aria-expanded={false}
                  >
                    {actionLabel}
                  </Button>
                </div>
              ) : null}
            </div>
            {expanded ? (
              <div className="px-[19px] pb-[17px] max-[480px]:px-3.5">{children}</div>
            ) : null}
          </>
        )}
      </section>
      {!complete ? <p className="mt-2.5 text-[10px] leading-[1.6] text-fg-subtle">{note}</p> : null}
    </div>
  );
}
