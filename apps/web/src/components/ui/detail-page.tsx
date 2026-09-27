import { Children, isValidElement, type ReactNode } from "react";

import { LogoTileSizeProvider } from "@/components/ui/logo-tile";
import { cn } from "@/lib/utils";

export { DetailPage, type DetailBackLink } from "@/components/ui/detail-sheet";

/* ----------------------------------------------------------------------------
   The detail page anatomy (the decided detail pick, B). Anything you open -
   a variable set, a model account, a person, an API key, a schedule, a
   knowledge entry, a workspace - is its own page inside the content area,
   never a side sheet:

     <DetailPage back={{ label: "Variable sets", onClick }}>   "← Variable sets"
       <DetailPageHeader                                         tile, title, chips,
         leading={<LogoTile .../>} title="Production"            meta line, actions
         chips={<MetaChip>Organization</MetaChip>}
         meta={["by Maja Berg", "12 variables", "updated 3 days ago"]}
         actions={<Button>…</Button>}
         tabs={<LineTabsNav>…</LineTabsNav>}                     underline tabs
       />
       <DetailPageBody aside={<DetailAside>…</DetailAside>}>     main column +
         <DetailSection title="Variables">…</DetailSection>      quiet right card
       </DetailPageBody>
     </DetailPage>

   DetailSection, DetailFacts and DetailFooter from detail-sheet.tsx render in
   their page form inside a DetailPage.
   -------------------------------------------------------------------------- */

export interface DetailPageHeaderProps {
  /** A LogoTile or avatar. Rendered at 40px. */
  leading?: ReactNode;
  title: ReactNode;
  /** Small chips right of the title: a StatusBadge, a MetaChip ("New", "Organization"). */
  chips?: ReactNode;
  /** The meta line: "by Maja Berg · in Platform engineering · updated Sep 15". Pass parts as an array. */
  meta?: ReactNode;
  /** The page's actions: one primary or secondary button and a ⋯ menu. */
  actions?: ReactNode;
  /** An underline tab row (LineTabsNav or LineTabsList) under the header. */
  tabs?: ReactNode;
  className?: string;
}

/** Joins meta parts with a middle dot. Falsy parts are skipped. */
export function DetailMeta({ children, className }: { children: ReactNode; className?: string }) {
  // Children.toArray already drops null, undefined and booleans.
  const parts = Children.toArray(children).filter((part) => part !== "");
  return (
    <p className={cn("m-0 min-w-0 text-sm leading-5 text-fg-muted", className)}>
      {parts.map((part, index) => (
        // The dot travels with the part after it, so a wrapped line never ends
        // on a dangling separator. A part moves to the next line whole; only a
        // part longer than the line wraps inside.
        <span
          key={isValidElement(part) && part.key !== null ? part.key : index}
          className="inline-block max-w-full align-top"
        >
          {index > 0 ? (
            <span aria-hidden="true" className="px-1.5 text-fg-subtle">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </p>
  );
}

export function DetailPageHeader({
  leading,
  title,
  chips,
  meta,
  actions,
  tabs,
  className,
}: DetailPageHeaderProps) {
  const metaLine = Array.isArray(meta) ? <DetailMeta>{meta}</DetailMeta> : meta;
  return (
    <header data-slot="detail-page-header" className={cn("min-w-0", className)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-4">
          {leading ? (
            <div className="shrink-0">
              <LogoTileSizeProvider size="lg">{leading}</LogoTileSizeProvider>
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {/* Focusable from script only: a page opened in place moves focus to its title. */}
              <h1
                tabIndex={-1}
                data-slot="detail-page-title"
                className="min-w-0 text-xl leading-7 font-semibold tracking-[-0.5px] break-words text-fg outline-none"
              >
                {title}
              </h1>
              {chips}
            </div>
            {metaLine ? <div className="mt-0.5 min-w-0">{metaLine}</div> : null}
          </div>
        </div>
        {actions ? (
          <div data-slot="detail-page-actions" className="flex shrink-0 items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {tabs ? <div className="mt-6 min-w-0">{tabs}</div> : null}
    </header>
  );
}

/**
 * The page body: one main column and an optional quiet aside card on the
 * right (Created by, Scope, Used by). The aside drops under the main column
 * below 620px of width.
 */
export function DetailPageBody({
  aside,
  children,
  className,
}: {
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="detail-page-body"
      className={cn(
        "grid min-w-0 gap-x-8 gap-y-2",
        aside ? "@[620px]/detail:grid-cols-[minmax(0,1fr)_240px]" : null,
        className,
      )}
    >
      {/* Hairlines only between visible sections, so hidden tab panels leave no stray rule. */}
      <div className="flex min-w-0 flex-col [&>*]:border-border [&>:not([hidden])~:not([hidden])]:border-t">
        {children}
      </div>
      {aside ? <div className="min-w-0 pt-2 @[620px]/detail:pt-8">{aside}</div> : null}
    </div>
  );
}

/** The quiet metadata card: label/value items, no border, surface fill. */
export function DetailAside({
  children,
  label = "Details",
  className,
}: {
  children: ReactNode;
  /** Accessible name of the card. */
  label?: string;
  className?: string;
}) {
  return (
    <aside
      aria-label={label}
      data-slot="detail-aside"
      className={cn(
        "flex min-w-0 flex-col gap-5 rounded-[14px] bg-surface-2/70 p-5 @[620px]/detail:sticky @[620px]/detail:top-6",
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function DetailAsideItem({
  label,
  icon,
  children,
}: {
  label: ReactNode;
  /** A 14px icon shown in a small tile before the value. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs leading-4.5 text-fg-muted">{label}</div>
      <div className="mt-1.5 flex min-w-0 items-start gap-2 text-sm leading-5 text-fg">
        {icon ? (
          <span
            aria-hidden="true"
            className="-mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-surface text-fg-muted [&_svg]:size-3.5"
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1 break-words">{children}</div>
      </div>
    </div>
  );
}
