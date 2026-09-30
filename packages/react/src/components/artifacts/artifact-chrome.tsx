import { OpenGeniApiError } from "@opengeni/sdk";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  FileIcon,
  FilePenLineIcon,
  GalleryHorizontalEndIcon,
  ImageIcon,
  Loader2Icon,
  PanelsTopLeftIcon,
  RotateCcwIcon,
  Table2Icon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";

/**
 * Shared chrome for artifact surfaces: the OpenGeni console and embedding hosts
 * render the same header, controls, and load states. Class names use the
 * package theme aliases, so the console's own Tailwind build and the compiled
 * `.og-root` stylesheet resolve them identically.
 */

export type ArtifactKind = "document" | "spreadsheet" | "presentation" | "site" | "image" | "file";

const BUTTON_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const BUTTON_VARIANT = {
  ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
  outline:
    "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-input/30 dark:hover:bg-input/50",
} as const;
const BUTTON_SIZE = {
  sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
  icon: "size-9",
  "icon-sm": "size-8",
} as const;

export function ArtifactButton({
  variant = "ghost",
  size = "sm",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & {
  variant?: keyof typeof BUTTON_VARIANT;
  size?: keyof typeof BUTTON_SIZE;
}) {
  return (
    <button
      type={type}
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...props}
    />
  );
}

export function ArtifactBadge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-border px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground [&>svg]:pointer-events-none [&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export const ArtifactSelect = forwardRef<HTMLSelectElement, ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => (
    <span className="relative inline-block max-w-full">
      <select
        ref={ref}
        className={cn(
          "peer h-9 w-full appearance-none rounded-md border border-border bg-bg px-2.5 pr-8 text-sm text-fg transition-colors hover:border-border-strong focus-visible:border-ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
      />
    </span>
  ),
);
ArtifactSelect.displayName = "ArtifactSelect";

export function artifactKindIcon(kind: ArtifactKind): ReactNode {
  if (kind === "image") return <ImageIcon className="size-4" />;
  if (kind === "file") return <FileIcon className="size-4" />;
  if (kind === "site") return <PanelsTopLeftIcon className="size-4" />;
  if (kind === "document") return <FilePenLineIcon className="size-4" />;
  if (kind === "spreadsheet") return <Table2Icon className="size-4" />;
  return <GalleryHorizontalEndIcon className="size-4" />;
}

export function artifactKindSubtitle(kind: ArtifactKind): string {
  if (kind === "site") return "Site · published preview";
  if (kind === "image") return "Image · retained file";
  if (kind === "file") return "File · retained file";
  return `${kind[0]!.toUpperCase()}${kind.slice(1)} · shared editor`;
}

type LoadErrorCopy = Readonly<
  Record<
    "unavailable" | "invalid" | "transient",
    {
      title: string;
      message: string;
    }
  >
>;

/**
 * Every user-facing string in the artifact surfaces (inline Site preview, Site
 * frame, viewer header and states). Hosts translate by passing a partial
 * `labels` object; unspecified keys keep the English defaults.
 */
export type ArtifactLabels = Readonly<{
  back: string;
  close: string;
  /** Header title and loading copy until an artifact's title is known. */
  opening: string;
  /** Header title when an artifact cannot be opened. */
  artifact: string;
  startingEditor: string;
  kindSubtitle: (kind: ArtifactKind) => string;
  live: string;
  reloadSite: string;
  openFullScreen: string;
  editWithAgent: string;
  editShort: string;
  preview: string;
  loadPreview: string;
  loadSitePreview: string;
  siteVersion: string;
  savedVersion: string;
  version: (revision: number) => string;
  openSite: string;
  loadingSite: string;
  siteArchived: string;
  siteUnpublished: string;
  siteReferenceInvalid: string;
  siteLoadFailed: string;
  retry: string;
  tryAgain: string;
  toolCount: (count: number) => string;
  toolsAvailable: (count: number) => string;
  sourceFileCount: (count: number) => string;
  viewingDisabled: { title: string; message: string };
  editorsMissing: { title: string; message: string };
  siteErrors: LoadErrorCopy;
  editableErrors: LoadErrorCopy;
  reference: (id: string) => string;
}>;

export const DEFAULT_ARTIFACT_LABELS: ArtifactLabels = Object.freeze({
  back: "Back",
  close: "Close",
  opening: "Opening artifact…",
  artifact: "Artifact",
  startingEditor: "Starting the secure editing session…",
  kindSubtitle: (kind: ArtifactKind) => artifactKindSubtitle(kind),
  live: "Live",
  reloadSite: "Reload Site",
  openFullScreen: "Open Site full screen",
  editWithAgent: "Edit with Geni",
  editShort: "Edit",
  preview: "Preview",
  loadPreview: "Load preview",
  loadSitePreview: "Load Site preview",
  siteVersion: "Site version",
  savedVersion: "Saved version",
  version: (revision: number) => `Version ${revision}`,
  openSite: "Open Site",
  loadingSite: "Loading Site…",
  siteArchived: "This Site is archived.",
  siteUnpublished: "This Site is archived or unpublished.",
  siteReferenceInvalid: "This Site reference is invalid.",
  siteLoadFailed: "Couldn’t load this Site.",
  retry: "Retry",
  tryAgain: "Try again",
  toolCount: (count: number) => `${count} ${count === 1 ? "tool" : "tools"}`,
  toolsAvailable: (count: number) => `${count} workspace tools available to this Site`,
  sourceFileCount: (count: number) => `${count} source ${count === 1 ? "file" : "files"}`,
  viewingDisabled: {
    title: "Artifact viewing isn't enabled",
    message: "This app doesn't serve editable artifacts yet.",
  },
  editorsMissing: {
    title: "This artifact can't open here",
    message: "This app hasn't installed the document, spreadsheet, and presentation editors.",
  },
  siteErrors: {
    unavailable: {
      title: "This Site isn't available",
      message: "It may have been removed, or you may not have access.",
    },
    invalid: {
      title: "This Site link isn't valid",
      message: "Check the address and open a Site from your workspace library.",
    },
    transient: {
      title: "Couldn't load this Site",
      message: "A temporary problem prevented this Site from loading. Try again.",
    },
  },
  editableErrors: {
    unavailable: {
      title: "This artifact isn't available",
      message: "It may have been removed, or you may not have access.",
    },
    invalid: {
      title: "This artifact link isn't valid",
      message: "Check the address and open the artifact from your workspace library.",
    },
    transient: {
      title: "Could not open this artifact",
      message: "A temporary problem prevented this artifact from opening. Try again.",
    },
  },
  reference: (id: string) => `Reference: ${id}`,
});

const ArtifactLabelsContext = createContext<ArtifactLabels>(DEFAULT_ARTIFACT_LABELS);

/** Translate every artifact surface below; nested providers override outer ones. */
export function ArtifactLabelsProvider({
  labels,
  children,
}: {
  labels: Partial<ArtifactLabels> | undefined;
  children: ReactNode;
}) {
  const parent = useContext(ArtifactLabelsContext);
  const value = useMemo(() => (labels ? { ...parent, ...labels } : parent), [labels, parent]);
  return <ArtifactLabelsContext.Provider value={value}>{children}</ArtifactLabelsContext.Provider>;
}

export function useArtifactLabels(): ArtifactLabels {
  return useContext(ArtifactLabelsContext);
}

/**
 * One artifact header: optional Back, the kind tile, title (or a host-supplied
 * title control), trailing actions, and optional Close. The console dock and
 * embedded viewers share it.
 */
export function ArtifactViewerHeader({
  kind,
  title,
  subtitle,
  titleSlot,
  onBack,
  backLabel,
  actions,
  onClose,
  closeLabel,
}: Readonly<{
  /** `null` while the host does not know the modality yet. */
  kind: ArtifactKind | null;
  title: string;
  subtitle?: string | undefined;
  /** Replaces the title text, for example with a picker. */
  titleSlot?: ReactNode;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  actions?: ReactNode;
  onClose?: (() => void) | undefined;
  closeLabel?: string | undefined;
}>) {
  const labels = useArtifactLabels();
  backLabel ??= labels.back;
  closeLabel ??= labels.close;
  return (
    <div
      data-og-artifact-header=""
      className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-2"
    >
      {onBack ? (
        <ArtifactButton size="icon-sm" aria-label={backLabel} title={backLabel} onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </ArtifactButton>
      ) : null}
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
        {kind ? artifactKindIcon(kind) : <FileIcon className="size-4" />}
      </span>
      {titleSlot ?? (
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-sm font-medium">{title}</p>
          {(subtitle ?? (kind ? labels.kindSubtitle(kind) : "")) ? (
            <p className="m-0 truncate text-xs text-fg-subtle">
              {subtitle ?? (kind ? labels.kindSubtitle(kind) : "")}
            </p>
          ) : null}
        </div>
      )}
      {actions}
      {onClose ? (
        <ArtifactButton
          size="icon-sm"
          className="shrink-0"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </ArtifactButton>
      ) : null}
    </div>
  );
}

export function ArtifactLoading({ label }: { label: string }) {
  return (
    <section
      role="status"
      className="grid h-full min-h-0 flex-1 grid-cols-[minmax(0,1fr)] place-items-center px-4 text-center"
    >
      <div className="max-w-sm rounded-lg border border-border bg-surface p-5 text-sm text-fg-muted">
        <Loader2Icon aria-hidden className="mx-auto mb-3 size-5 animate-spin text-fg" />
        {label}
      </div>
    </section>
  );
}

export function ArtifactProblem({
  view,
  onRetry,
}: {
  view: ArtifactLoadErrorView;
  onRetry?: (() => void) | undefined;
}) {
  const labels = useArtifactLabels();
  return (
    <section
      role="alert"
      className="grid h-full min-h-0 flex-1 grid-cols-[minmax(0,1fr)] place-items-center px-4 text-center"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-5">
        <AlertTriangleIcon aria-hidden className="mx-auto mb-3 size-5 text-status-waiting" />
        <h2 className="m-0 text-base font-semibold">{view.title}</h2>
        <p className="mb-0 mt-2 text-sm leading-5 text-fg-muted">
          {artifactLoadErrorMessage(view, labels)}
        </p>
        {view.retryable && onRetry ? (
          <div className="mt-4 flex justify-center">
            <ArtifactButton variant="outline" onClick={onRetry}>
              <RotateCcwIcon aria-hidden="true" />
              {labels.tryAgain}
            </ArtifactButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export type ArtifactLoadErrorKind = "site" | "editable";

export type ArtifactLoadErrorView = Readonly<{
  title: string;
  message: string;
  retryable: boolean;
  correlationId?: string;
}>;

/** Site/editor load copy. Never surfaces raw OpenGeni API status text. */
export function artifactLoadErrorView(
  error: unknown,
  kind: ArtifactLoadErrorKind,
  labels: ArtifactLabels = DEFAULT_ARTIFACT_LABELS,
): ArtifactLoadErrorView {
  const copy = kind === "site" ? labels.siteErrors : labels.editableErrors;
  const correlationId = error instanceof OpenGeniApiError ? error.correlationId : undefined;
  const withSupport = (view: {
    title: string;
    message: string;
    retryable: boolean;
  }): ArtifactLoadErrorView => (correlationId ? { ...view, correlationId } : view);
  if (error instanceof OpenGeniApiError) {
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return withSupport({ ...copy.unavailable, retryable: false });
    }
    if (error.status === 422) return withSupport({ ...copy.invalid, retryable: false });
    return withSupport({ ...copy.transient, retryable: error.retryable });
  }
  return { ...copy.transient, retryable: true };
}

export function artifactLoadErrorMessage(
  view: ArtifactLoadErrorView,
  labels: ArtifactLabels = DEFAULT_ARTIFACT_LABELS,
): string {
  return view.correlationId
    ? `${view.message} ${labels.reference(view.correlationId)}`
    : view.message;
}
