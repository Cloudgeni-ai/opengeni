import { useEffect, useRef, type ReactNode } from "react";

import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailFact, DetailFacts, DetailSection } from "@/components/ui/detail-sheet";
import { Disclosure } from "@/components/ui/disclosure";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { StatusBadge, type ProductStatus } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   The one detail anatomy behind every Capabilities row (DESIGN.md section 8):
   a connection, a skill and a plugin all open a page with a back link, a
   40px tile, the title with its status, a "by X" meta line, the main column
   of sections and a quiet aside card. Endpoints, scopes, registry names and
   IDs live in one collapsed "Technical details" at the end.
   -------------------------------------------------------------------------- */

/**
 * The capability's logo on the shared tile. A brand logo sits on a light
 * plate in both themes (most vendor marks are drawn for a white background);
 * a missing or broken logo is a quiet monogram, and non-brand things (skills,
 * plugins, custom APIs) pass a lucide glyph so a fallback never looks like a
 * real logo.
 */
export function CapabilityMark({
  src,
  name,
  icon,
  size,
}: {
  src?: string | null;
  name: string;
  icon?: ReactNode;
  size?: LogoTileSize;
}) {
  return (
    <LogoTile
      size={size}
      name={name}
      icon={src ? undefined : icon}
      src={src ?? null}
      fit="contain"
      className={src ? "bg-surface dark:bg-fg" : undefined}
    />
  );
}

/** The status words every Capabilities surface uses, mapped onto the one status language. */
export type CapabilityStatusLabel =
  | "Connected"
  | "Needs attention"
  | "Not connected"
  | "Set up by an admin"
  | "Access restricted"
  | "Loading"
  | "Installed"
  | "Not installed"
  | "Update available"
  | "Installing"
  | "Unavailable"
  | "Pending changes"
  | "Inactive";

const STATUS: Record<
  CapabilityStatusLabel,
  { status?: ProductStatus; tone?: "neutral" | "attention" | "progress"; label?: string } | null
> = {
  Connected: { status: "connected" },
  "Needs attention": { status: "needs_reconnect", label: "Needs attention" },
  "Not connected": null,
  "Set up by an admin": { tone: "neutral", label: "Managed by an admin" },
  "Access restricted": { status: "unavailable", label: "Access restricted" },
  Loading: null,
  Installed: { status: "installed" },
  "Not installed": null,
  "Update available": { tone: "attention", label: "Update available" },
  Installing: { tone: "progress", label: "Installing" },
  Unavailable: { status: "unavailable" },
  "Pending changes": { status: "pending_review", label: "Pending changes" },
  Inactive: { status: "off", label: "Inactive" },
};

/** The header badge. Routine "not connected" states show nothing: the primary action says it. */
export function CapabilityStatus({ label }: { label: string }) {
  const entry = STATUS[label as CapabilityStatusLabel];
  if (!entry) return null;
  return (
    <StatusBadge status={entry.status} tone={entry.tone} variant="outline">
      {entry.label}
    </StatusBadge>
  );
}

export interface CapabilityPageProps {
  /** Returns to the catalog (or the provider page this one was opened from). */
  onBack: () => void;
  backLabel?: string;
  mark: ReactNode;
  title: ReactNode;
  /** A status label from the vocabulary above, or a custom node. */
  status?: string | ReactNode;
  chips?: ReactNode;
  /** "by Google", "Email": joined with " · ". */
  meta?: ReactNode[];
  /** At most one primary and a ⋯ menu. */
  actions?: ReactNode;
  tabs?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}

/** The page frame. Focus moves to the title when the page opens in place. */
export function CapabilityPage({
  onBack,
  backLabel = "Capabilities",
  mark,
  title,
  status,
  chips,
  meta,
  actions,
  tabs,
  aside,
  children,
}: CapabilityPageProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const heading = root.current?.querySelector<HTMLElement>("[data-slot=detail-page-title]");
    heading?.focus({ preventScroll: true });
    root.current?.scrollIntoView?.({ block: "start" });
  }, []);
  return (
    <div ref={root} data-capability-page="">
      <DetailPage back={{ label: backLabel, onClick: onBack }}>
        <DetailPageHeader
          leading={mark}
          title={title}
          chips={
            status || chips ? (
              <>
                {typeof status === "string" ? <CapabilityStatus label={status} /> : status}
                {chips}
              </>
            ) : undefined
          }
          meta={meta && meta.some(Boolean) ? meta : undefined}
          actions={actions}
          tabs={tabs}
        />
        <div className={cn("min-w-0", tabs ? "mt-0" : "mt-6 border-t border-border")}>
          <DetailPageBody aside={aside}>{children}</DetailPageBody>
        </div>
      </DetailPage>
    </div>
  );
}

export type TechnicalFact = { label: string; value: ReactNode; mono?: boolean };

/**
 * Endpoints, scopes, registry names and IDs: collapsed at the end of the page,
 * one level deep. Renders nothing when there is nothing technical to show.
 */
export function TechnicalDetails({
  facts,
  summary,
  children,
}: {
  facts: TechnicalFact[];
  summary?: ReactNode;
  children?: ReactNode;
}) {
  const shown = facts.filter(
    (fact) => fact.value !== null && fact.value !== undefined && fact.value !== "",
  );
  if (shown.length === 0 && !children) return null;
  return (
    <DetailSection>
      <Disclosure
        variant="row"
        title="Technical details"
        summary={
          summary ??
          shown
            .map((fact) => fact.label)
            .slice(0, 4)
            .join(", ")
        }
      >
        <div className="pt-2 pb-1">
          {shown.length ? (
            <DetailFacts>
              {shown.map((fact) => (
                <DetailFact key={fact.label} label={fact.label}>
                  <span className={cn("break-all", fact.mono && "font-mono text-xs leading-5")}>
                    {fact.value}
                  </span>
                </DetailFact>
              ))}
            </DetailFacts>
          ) : null}
          {children ? <div className={cn(shown.length ? "mt-4" : null)}>{children}</div> : null}
        </div>
      </Disclosure>
    </DetailSection>
  );
}

/** "What it can do": at most a few plain bullets. */
export function OutcomeList({ items }: { items: { title: string; description?: string }[] }) {
  if (!items.length) return null;
  return (
    <ul className="m-0 grid list-none gap-3 p-0">
      {items.map((item) => (
        <li key={item.title} className="flex min-w-0 gap-3">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-fg-subtle" />
          <span className="min-w-0">
            <span className="block text-sm leading-5 text-fg">{item.title}</span>
            {item.description ? (
              <span className="mt-0.5 block text-xs leading-4.5 text-fg-muted">
                {item.description}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The quiet aside card with label/value items. */
export function CapabilityAside({
  name,
  items,
}: {
  name: string;
  items: Array<{ label: string; value: ReactNode; icon?: ReactNode } | null | false>;
}) {
  const shown = items.filter(
    (item): item is { label: string; value: ReactNode; icon?: ReactNode } => Boolean(item),
  );
  if (!shown.length) return null;
  return (
    <DetailAside label={`About ${name}`}>
      {shown.map((item) => (
        <DetailAsideItem key={item.label} label={item.label} icon={item.icon}>
          {item.value}
        </DetailAsideItem>
      ))}
    </DetailAside>
  );
}
