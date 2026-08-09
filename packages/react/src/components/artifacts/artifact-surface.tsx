import {
  FileSpreadsheetIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PresentationIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ArtifactModality = "spreadsheet" | "document" | "presentation";

export type ArtifactSurfaceProps = {
  modality: ArtifactModality;
  title: string;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
  busy?: boolean | undefined;
  className?: string | undefined;
};

const MODALITY_LABEL: Record<ArtifactModality, string> = {
  spreadsheet: "Spreadsheet",
  document: "Document",
  presentation: "Presentation",
};

function ModalityIcon({ modality }: { modality: ArtifactModality }) {
  switch (modality) {
    case "spreadsheet":
      return <FileSpreadsheetIcon className="size-4" />;
    case "document":
      return <FileTextIcon className="size-4" />;
    case "presentation":
      return <PresentationIcon className="size-4" />;
  }
}

/**
 * Modality-neutral artifact chrome. It deliberately owns no file, session, or
 * persistence state: hosts can use the same surface for a local draft, a
 * durable OpenGeni artifact, or a collaborative projection.
 */
export function ArtifactSurface({
  modality,
  title,
  subtitle,
  actions,
  children,
  footer,
  busy = false,
  className,
}: ArtifactSurfaceProps) {
  return (
    <section
      aria-label={`${MODALITY_LABEL[modality]}: ${title}`}
      aria-busy={busy || undefined}
      data-og-artifact-modality={modality}
      className={cn(
        "og-root flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1 text-og-fg shadow-og-md",
        className,
      )}
    >
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-og-border bg-og-surface-2 px-3">
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-og-sm bg-og-surface-3 text-og-fg-muted"
        >
          <ModalityIcon modality={modality} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-og-base font-medium text-og-fg">{title}</h2>
          {subtitle ? <div className="truncate text-og-xs text-og-fg-muted">{subtitle}</div> : null}
        </div>
        {busy ? (
          <LoaderCircleIcon
            aria-label="Updating artifact"
            className="size-4 shrink-0 animate-spin text-og-fg-muted"
          />
        ) : null}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>

      <div className="min-h-0 min-w-0 flex-1">{children}</div>

      {footer ? (
        <footer className="shrink-0 border-t border-og-border bg-og-surface-2">{footer}</footer>
      ) : null}
    </section>
  );
}
