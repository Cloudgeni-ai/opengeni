import {
  ArrowLeftIcon,
  Globe2Icon,
  Maximize2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import {
  PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX,
  PublishedHtmlArtifactFrame,
  publishedHtmlArtifactDocument,
  type PublishedHtmlArtifactToolBridge,
} from "@opengeni/react/artifacts";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export { PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX, publishedHtmlArtifactDocument };

export function ArtifactSandbox(props: {
  html: string;
  title: string;
  versionLabel?: string;
  className?: string;
  editDisabled?: boolean;
  onEdit?: () => void;
  toolBridge?: PublishedHtmlArtifactToolBridge;
  connectedToolCount?: number;
  sourceFileCount?: number;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [focused, setFocused] = useState(false);
  const reload = () => {
    setReloadKey((value) => value + 1);
  };
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-border/80 bg-white shadow-sm",
        focused && "fixed inset-0 z-50 flex flex-col rounded-none border-0 bg-surface shadow-none",
        props.className,
      )}
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-surface/95 px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {focused ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2"
              onClick={() => setFocused(false)}
            >
              <ArrowLeftIcon className="mr-2 size-3.5" />
              Back
            </Button>
          ) : null}
          {!focused ? (
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-fg-muted">
              <Globe2Icon className="size-3.5" />
            </span>
          ) : null}
          <span className="truncate text-xs font-semibold text-fg">{props.title}</span>
          {props.versionLabel ? (
            <Badge
              variant="outline"
              className="hidden h-5 rounded-md border-border/80 px-1.5 text-2xs font-normal text-fg-muted sm:inline-flex"
            >
              {props.versionLabel}
            </Badge>
          ) : null}
          {props.connectedToolCount ? (
            <Badge
              variant="outline"
              className="hidden h-5 max-w-40 gap-1 rounded-md border-border/80 px-1.5 text-2xs font-normal text-fg-muted sm:inline-flex"
              title={`${props.connectedToolCount} workspace tools available to this Site`}
            >
              <PlugZapIcon className="size-3" />
              {props.connectedToolCount} {props.connectedToolCount === 1 ? "tool" : "tools"}
            </Badge>
          ) : null}
          {props.sourceFileCount ? (
            <span className="hidden text-2xs text-fg-subtle xl:inline">
              {props.sourceFileCount} source {props.sourceFileCount === 1 ? "file" : "files"}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {focused && props.onEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              disabled={props.editDisabled}
              onClick={props.onEdit}
            >
              <SparklesIcon className="mr-2 size-3.5" />
              <span className="hidden sm:inline">Edit with Geni</span>
              <span className="sm:hidden">Edit</span>
            </Button>
          ) : null}
          <span className="mr-1 hidden items-center gap-1.5 text-2xs font-medium text-fg-muted sm:inline-flex">
            <span className="size-1.5 rounded-full bg-status-success ring-4 ring-status-success/10" />
            Live
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-md text-fg-muted hover:text-fg"
            aria-label="Reload Site"
            onClick={reload}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          {!focused ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-md text-fg-muted hover:text-fg"
              aria-label="Open Site full screen"
              onClick={() => setFocused(true)}
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      <PublishedHtmlArtifactFrame
        key={reloadKey}
        title={props.title}
        html={props.html}
        toolBridge={props.toolBridge}
        className={cn(
          "h-[clamp(30rem,62vh,48rem)] w-full border-0 bg-white",
          focused && "min-h-0 flex-1",
        )}
      />
    </section>
  );
}
